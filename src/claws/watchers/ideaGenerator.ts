import cron from "node-cron";
import { listAllUsers } from "../../db/userStore";
import { getUserProfile } from "../../db/profileStore";
import { performTavilySearch } from "../wire/tools/web_search";
import { checkAndConsumeTavilyBudget } from "../sense/apiBudget";

const CHECK_CRON = "0 14 * * MON"; // Mondays 14:00 UTC (low cadence, cheap)

function formatIdeas(raw: string, fallbackNiche: string): string[] {
    const lines = raw
        .split(/\r?\n/)
        .map((l) => l.replace(/^[-•\d\.\)]+\s*/, "").trim())
        .filter(Boolean);
    const uniq = Array.from(new Set(lines));
    if (uniq.length > 0) return uniq.slice(0, 5);
    // fallback templates
    return [
        `Weekly roundup: What changed in ${fallbackNiche} this week?`,
        `Behind-the-scenes: how I'm building for ${fallbackNiche}`,
        `Quick tip: a 3-step playbook for ${fallbackNiche} creators`,
        `Case study: a win (or failure) from last week`,
        `Hot take: what's overrated in ${fallbackNiche}`,
    ];
}

export function startIdeaGeneratorWatcher(
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
                const contentMode = Boolean(prefs.contentMode);
                const niche = (prefs.contentNiche as string | undefined)?.trim() || "your audience";

                if (!contentMode) continue; // opt-in only

                let ideas: string[] = [];
                let note = "";

                const budget = await checkAndConsumeTavilyBudget(telegramId);
                if (budget.allowed) {
                    try {
                        const raw = await performTavilySearch(`trending topics and angles for ${niche} this week, 5 concise bullets`, 5);
                        ideas = formatIdeas(raw, niche);
                    } catch (err) {
                        note = "(search unavailable, using templates)";
                        ideas = formatIdeas("", niche);
                    }
                } else {
                    note = `(skipped search: ${budget.reason})`;
                    ideas = formatIdeas("", niche);
                }

                if (!ideas.length) continue;

                const message = [
                    "💡 Content Ideas",
                    `Niche: ${niche} ${note}`.trim(),
                    "",
                    ...ideas.map((i, idx) => `${idx + 1}. ${i}`),
                    "",
                    "Buttons: Draft thread | Save for later",
                ].filter(Boolean).join("\n");

                const reply_markup = {
                    inline_keyboard: [
                        [
                            { text: "Draft thread", callback_data: "ideas:draft" },
                            { text: "Save for later", callback_data: "ideas:save" },
                        ],
                    ],
                };

                try {
                    await sendMessage(telegramId, message, { reply_markup });
                    console.log(`[idea-generator] Sent ideas to ${telegramId} (niche=${niche})`);
                } catch (err) {
                    console.error(`[idea-generator] Failed to send to ${telegramId}:`, err);
                }
            }
        } catch (err) {
            console.error("[idea-generator] Loop failed:", err);
        }
    });

    console.log(`[idea-generator] Scheduler active — cron: "${CHECK_CRON}"`);
}
