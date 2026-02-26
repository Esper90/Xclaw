import cron from "node-cron";
import { listAllUsers } from "../../db/userStore";
import { hasUserXCreds } from "../../db/getUserClient";
import { getUserProfile } from "../../db/profileStore";

const CHECK_CRON = "0 15 * * MON"; // Mondays 15:00 UTC

export function startFeedbackAnalyzerWatcher(
    sendMessage: (chatId: number, text: string, extra?: { reply_markup?: any }) => Promise<void>
): void {
    cron.schedule(CHECK_CRON, async () => {
        try {
            const users = await listAllUsers();
            if (!users || users.length === 0) return;

            for (const user of users) {
                const telegramId = user.telegram_id;
                const hasX = await hasUserXCreds(telegramId);
                if (!hasX) continue; // only runs when X creds exist

                const profile = await getUserProfile(telegramId);
                const niche = (profile.prefs as any)?.contentNiche as string | undefined;

                const tips = [
                    "Compare last 3 posts: double-down on the format with the highest engagement (thread vs single).",
                    "Add a visual to your next post; image posts often lift CTR.",
                    "End with a CTA question to invite replies and signal to the algo.",
                ];

                const message = [
                    "📊 Feedback Pulse (weekly)",
                    niche ? `Niche: ${niche}` : "",
                    "",
                    "Signals: X data accessible — deeper analytics will run on your next posts.",
                    "Actionable next steps:",
                    tips.map((t, i) => `${i + 1}. ${t}`).join("\n"),
                    "",
                    "Buttons: Apply to next post | Snooze",
                ].filter(Boolean).join("\n");

                const reply_markup = {
                    inline_keyboard: [
                        [
                            { text: "Apply tip", callback_data: "feedback:apply" },
                            { text: "Snooze", callback_data: "feedback:snooze" },
                        ],
                    ],
                };

                try {
                    await sendMessage(telegramId, message, { reply_markup });
                    console.log(`[feedback] Sent pulse to ${telegramId}`);
                } catch (err) {
                    console.error(`[feedback] Failed to send to ${telegramId}:`, err);
                }
            }
        } catch (err) {
            console.error("[feedback] Loop failed:", err);
        }
    });

    console.log(`[feedback] Scheduler active — cron: "${CHECK_CRON}"`);
}
