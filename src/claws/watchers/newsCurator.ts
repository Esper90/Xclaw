import cron from "node-cron";
import { listAllUsers } from "../../db/userStore";
import { getUserProfile, updateUserProfile } from "../../db/profileStore";
import { performTavilySearch } from "../wire/tools/web_search";
import { checkAndConsumeTavilyBudget } from "../sense/apiBudget";

const CHECK_CRON = "0 */3 * * *"; // every 3 hours

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
