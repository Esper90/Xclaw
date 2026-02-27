import cron from "node-cron";
import { hasUserXCreds, getUserXClient } from "../../db/getUserClient";
import { listAllUsers } from "../../db/userStore";
import { getUserProfile, updateUserProfile } from "../../db/profileStore";
import { checkAndConsumeXBudget } from "../sense/apiBudget";

const CHECK_CRON = "*/30 * * * *"; // every 30 minutes
const MAX_HANDLES_PER_RUN = 3; // avoid blowing budget if vip_list is long
const TWEETS_PER_HANDLE = 3;
const COOLDOWN_NO_ACTIVITY_MINUTES = 60; // widen interval when nothing new

function isQuiet(prefs: Record<string, any>): boolean {
    if ((prefs as any).quietAll) return true;
    const start = Number(prefs.quietHoursStart);
    const end = Number(prefs.quietHoursEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    if (start === end) return false;
    const hour = new Date().getHours();
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
}

type VipDigestItem = { handle: string; text: string; id: string; createdAt?: string };

function normalizeHandle(handle: string): string {
    return handle.replace(/^@/, "").trim().toLowerCase();
}

async function fetchNewTweetsForHandle(
    telegramId: number,
    handle: string,
    sinceId?: string
): Promise<VipDigestItem[]> {
    const client = await getUserXClient(telegramId);
    const normalized = normalizeHandle(handle);

    const userRes = await client.v2.userByUsername(normalized, {
        "user.fields": ["username"],
    });
    if (!userRes.data) return [];

    const tl = await client.v2.userTimeline(userRes.data.id, {
        max_results: TWEETS_PER_HANDLE,
        "tweet.fields": ["created_at", "text"],
        exclude: ["retweets"],
        ...(sinceId ? { since_id: sinceId } : {}),
    } as any);

    const tweets = tl.data?.data ?? [];
    if (!tweets.length) return [];

    // If sinceId provided, userTimeline already filters; otherwise we still filter for > sinceId lexicographically
    const filtered = sinceId
        ? tweets
        : tweets.filter((t) => !sinceId || t.id > sinceId);

    return filtered.map((t) => ({
        handle: normalized,
        text: t.text,
        id: t.id,
        createdAt: t.created_at,
    }));
}

function renderDigest(items: VipDigestItem[]): string {
    const bullets = items.map((item) => {
        const preview = item.text.length > 160 ? `${item.text.slice(0, 160)}…` : item.text;
        return `• @${item.handle}: ${preview}`;
    });

    return [
        "🛰️ Timeline Sentinel",
        "New VIP activity detected:",
        "",
        ...bullets,
        "",
        "Buttons: Approve replies | Ignore",
    ]
        .filter(Boolean)
        .join("\n");
}

export function startTimelineSentinelWatcher(
    sendMessage: (chatId: number, text: string, extra?: { reply_markup?: any }) => Promise<void>
): void {
    cron.schedule(CHECK_CRON, async () => {
        try {
            const users = await listAllUsers();
            if (!users || users.length === 0) return;

            for (const user of users) {
                const telegramId = user.telegram_id;
                const hasX = await hasUserXCreds(telegramId);
                if (!hasX) continue;

                const profile = await getUserProfile(telegramId);
                const prefs = (profile.prefs || {}) as Record<string, any>;
                if (prefs.sentinelEnabled === false) continue;
                if (isQuiet(prefs)) continue;
                const vipList = profile.vipList ?? [];
                if (!vipList.length) {
                    // No VIPs configured; skip until user sets some.
                    continue;
                }

                const intervalMins = Math.max(10, Math.min(180, Number(prefs.sentinelIntervalMins) || 30));
                const lastRun = Number(prefs.sentinelLastRun) || 0;
                const lastIdle = Number(prefs.sentinelLastIdleAt) || 0;
                const now = Date.now();
                const intervalMs = intervalMins * 60 * 1000;
                const idleCooldownMs = COOLDOWN_NO_ACTIVITY_MINUTES * 60 * 1000;

                if (lastRun && now - lastRun < intervalMs) continue;
                if (lastIdle && now - lastIdle < Math.max(intervalMs, idleCooldownMs)) continue;

                const lastSeen = profile.lastTweetIds ?? {};
                const newLastSeen: Record<string, string> = { ...lastSeen };
                const digestItems: VipDigestItem[] = [];
                let sawActivity = false;

                for (const handle of vipList.slice(0, MAX_HANDLES_PER_RUN)) {
                    const budget = await checkAndConsumeXBudget(telegramId);
                    if (!budget.allowed) {
                        console.log(`[timeline-sentinel] Budget stop for ${telegramId}: ${budget.reason}`);
                        break;
                    }

                    try {
                        const normalized = normalizeHandle(handle);
                        const sinceId = lastSeen[normalized];
                        const tweets = await fetchNewTweetsForHandle(telegramId, normalized, sinceId);
                        if (tweets.length > 0) {
                            digestItems.push(...tweets);
                            sawActivity = true;
                            // update last seen to highest id
                            const maxId = tweets.reduce((max, t) => (t.id > max ? t.id : max), sinceId ?? "0");
                            newLastSeen[normalized] = maxId;
                        }
                    } catch (err) {
                        console.warn(`[timeline-sentinel] Failed handle ${handle} for ${telegramId}:`, err);
                    }
                }
                const prefsPatch: Record<string, any> = {
                    sentinelLastRun: now,
                    sentinelIntervalMins: intervalMins,
                    sentinelLastIdleAt: sawActivity ? null : now,
                };

                if (digestItems.length === 0) {
                    console.log(`[timeline-sentinel] No new VIP tweets for ${telegramId}`);
                    await updateUserProfile(telegramId, { prefs: { ...(profile.prefs || {}), ...prefsPatch }, lastTweetIds: newLastSeen });
                    continue;
                }

                const message = renderDigest(digestItems);
                const reply_markup = {
                    inline_keyboard: [
                        [
                            { text: "Approve replies", callback_data: "sentinel:approve" },
                            { text: "Ignore", callback_data: "sentinel:ignore" },
                        ],
                    ],
                };

                try {
                    await sendMessage(telegramId, message, { reply_markup });
                    await updateUserProfile(telegramId, {
                        lastTweetIds: newLastSeen,
                        prefs: {
                            ...(profile.prefs ?? {}),
                            ...prefsPatch,
                            sentinelCache: digestItems,
                        },
                    });
                    console.log(`[timeline-sentinel] Sent digest to ${telegramId} (items=${digestItems.length})`);
                } catch (err) {
                    console.error(`[timeline-sentinel] Failed to send digest to ${telegramId}:`, err);
                }
            }
        } catch (err) {
            console.error("[timeline-sentinel] Loop failed:", err);
        }
    });

    console.log(`[timeline-sentinel] Scheduler active — cron: "${CHECK_CRON}"`);
}
