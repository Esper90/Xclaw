import cron from "node-cron";
import { listAllUsers } from "../../db/userStore";
import { getUserProfile, updateUserProfile } from "../../db/profileStore";
import { checkAndConsumeTavilyBudget } from "../sense/apiBudget";
import { fetchCuratedNewsDigest } from "../sense/newsDigest";
import { getLocalDayKey, getLocalHour } from "../sense/time";

const CHECK_CRON = "0 */1 * * *"; // global poll; per-user cadence enforced via prefs
const DAY_MS = 24 * 60 * 60 * 1000;

type SavedDigest = {
    bullets?: string[];
    ts?: number;
    dayKey?: string;
};

function isQuiet(prefs: Record<string, any>, timezone: string | null | undefined): boolean {
    if ((prefs as any).quietAll) return true;
    const start = Number(prefs.quietHoursStart);
    const end = Number(prefs.quietHoursEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    if (start === end) return false; // zero window
    const hour = getLocalHour(timezone);
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end; // crosses midnight
}

function getFreshCachedBullets(
    digest: SavedDigest | undefined,
    timezone: string | null | undefined,
    maxItems = 3
): string[] {
    if (!digest?.bullets?.length || typeof digest.ts !== "number") return [];
    if (Date.now() - digest.ts > DAY_MS) return [];
    const dayKey = digest.dayKey ?? getLocalDayKey(timezone, digest.ts);
    if (dayKey !== getLocalDayKey(timezone)) return [];
    return digest.bullets.slice(0, maxItems);
}

export function startNewsCuratorWatcher(
    sendMessage: (chatId: number, text: string, extra?: { reply_markup?: any }) => Promise<void>
): void {
    cron.schedule(CHECK_CRON, async () => {
        try {
            const users = await listAllUsers();
            if (!users || users.length === 0) return;

            for (const user of users) {
                const telegramId = user.telegram_id;
                const profile = await getUserProfile(telegramId);
                const prefs = (profile.prefs || {}) as Record<string, any>;
                if (prefs.newsEnabled === false) continue;

                const topics = Array.isArray(prefs.newsTopics)
                    ? prefs.newsTopics.filter((t: any) => typeof t === "string" && t.trim())
                    : [];
                if (!topics.length) continue;

                const intervalHours = Number.isFinite(prefs.newsFetchIntervalHours)
                    ? Math.max(0, Math.min(48, Number(prefs.newsFetchIntervalHours)))
                    : 3;
                const lastTs = (prefs.newsDigest as any)?.ts as number | undefined;
                const sinceLast = lastTs ? Date.now() - lastTs : Infinity;
                if (intervalHours === 0) continue;
                if (sinceLast < intervalHours * 60 * 60 * 1000) continue;
                if (isQuiet(prefs, profile.timezone)) continue;

                const oldDigest = (prefs.newsDigest as SavedDigest | undefined);
                let bullets: string[] = [];
                let note = "";

                const budget = await checkAndConsumeTavilyBudget(telegramId);
                if (!budget.allowed) {
                    note = `(search skipped: ${budget.reason})`;
                    bullets = getFreshCachedBullets(oldDigest, profile.timezone);
                } else {
                    try {
                        const live = await fetchCuratedNewsDigest(topics, {
                            maxItems: 3,
                            timezone: profile.timezone,
                            includeX: true,
                        });
                        bullets = live.bullets;
                        note = `(fresh today: ${live.sameDayCount}/${Math.max(live.bullets.length, 1)}${live.hasXSource ? ", x pulse included" : ""})`;
                    } catch (err: any) {
                        note = `(search failed: ${err?.message ?? "error"})`;
                        bullets = getFreshCachedBullets(oldDigest, profile.timezone);
                    }
                }

                if (bullets.length === 0) {
                    bullets = topics.slice(0, 3).map((t: string) => `Track: ${t}`);
                    note = note || "(no fresh headlines yet)";
                }

                try {
                    const newPrefs = { ...(profile.prefs || {}) } as Record<string, unknown>;
                    (newPrefs as any).newsDigest = {
                        topics,
                        bullets,
                        ts: Date.now(),
                        dayKey: getLocalDayKey(profile.timezone),
                    };
                    await updateUserProfile(telegramId, { prefs: newPrefs });
                } catch (err) {
                    console.warn(`[news-curator] Failed to cache digest for ${telegramId}:`, err);
                }

                const message = [
                    "News: Curated Digest",
                    `Topics: ${topics.join(", ")}${note ? " " + note : ""}`.trim(),
                    "",
                    bullets.map((b, i) => `${i + 1}. ${b}`).join("\n"),
                ].filter(Boolean).join("\n");

                const reply_markup = {
                    inline_keyboard: [
                        [
                            { text: "Refresh", callback_data: "news:refresh" },
                            { text: "Dismiss", callback_data: "news:dismiss" },
                        ],
                    ],
                };

                try {
                    await sendMessage(telegramId, message, { reply_markup });
                    console.log(`[news-curator] Sent news to ${telegramId} (topics=${topics.length})`);
                } catch (err) {
                    console.error(`[news-curator] Failed to send to ${telegramId}:`, err);
                }
            }
        } catch (err) {
            console.error("[news-curator] Loop failed:", err);
        }
    });

    console.log(`[news-curator] Scheduler active - cron: "${CHECK_CRON}"`);
}
