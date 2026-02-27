import cron from "node-cron";
import { listAllUsers } from "../../db/userStore";
import { getUserProfile, updateUserProfile } from "../../db/profileStore";
import { performTavilySearch } from "../wire/tools/web_search";
import { checkAndConsumeTavilyBudget } from "../sense/apiBudget";

const CHECK_CRON = "0 */1 * * *"; // global poll; per-user cadence enforced via prefs

function isQuiet(prefs: Record<string, any>): boolean {
    if ((prefs as any).quietAll) return true;
    const start = Number(prefs.quietHoursStart);
    const end = Number(prefs.quietHoursEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    if (start === end) return false; // zero window
    const hour = new Date().getHours();
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end; // crosses midnight
}

function formatNews(raw: string): string[] {
    return raw
        .split(/\r?\n/)
        .map((l) => l.replace(/^[-•\d\.\)]+\s*/, "").trim())
        .filter(Boolean)
        .slice(0, 5);
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
                const topics = Array.isArray(prefs.newsTopics) ? prefs.newsTopics.filter((t: any) => typeof t === "string" && t.trim()) : [];
                if (!topics.length) continue;

                // Per-user cadence: skip if they've asked for slower fetches
                const intervalHours = Number.isFinite(prefs.newsFetchIntervalHours)
                    ? Math.max(0, Math.min(48, Number(prefs.newsFetchIntervalHours)))
                    : 3;
                const lastTs = (prefs.newsDigest as any)?.ts as number | undefined;
                const sinceLast = lastTs ? Date.now() - lastTs : Infinity;
                if (intervalHours === 0) continue; // user disabled proactive news
                if (sinceLast < intervalHours * 60 * 60 * 1000) continue;
                if (isQuiet(prefs)) continue; // respect quiet hours / master quiet

                const query = `top news for ${topics.join(", ")} today, 3 concise bullets with sources`;
                let bullets: string[] = [];
                let note = "";
                const prevDigest = (prefs.newsDigest as any)?.bullets as string[] | undefined;

                const budget = await checkAndConsumeTavilyBudget(telegramId);
                if (!budget.allowed) {
                    note = `(search skipped: ${budget.reason})`;
                    bullets = prevDigest ?? [];
                } else {
                    try {
                        const raw = await performTavilySearch(query, 4);
                        bullets = formatNews(raw);
                        // persist shared digest for brief reuse
                        const newPrefs = { ...(profile.prefs || {}) } as Record<string, unknown>;
                        (newPrefs as any).newsDigest = { topics, bullets, ts: Date.now() };
                        await updateUserProfile(telegramId, { prefs: newPrefs });
                    } catch (err) {
                        note = "(search failed, using last saved topics if any)";
                        bullets = prevDigest ?? [];
                    }
                }

                if (bullets.length === 0) {
                    bullets = topics.slice(0, 3).map((t: string) => `Track: ${t}`);
                }

                try {
                    const newPrefs = { ...(profile.prefs || {}) } as Record<string, unknown>;
                    (newPrefs as any).newsDigest = { topics, bullets, ts: Date.now() };
                    await updateUserProfile(telegramId, { prefs: newPrefs });
                } catch (err) {
                    console.warn(`[news-curator] Failed to cache digest for ${telegramId}:`, err);
                }

                const message = [
                    "📰 Curated News",
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

    console.log(`[news-curator] Scheduler active — cron: "${CHECK_CRON}"`);
}
