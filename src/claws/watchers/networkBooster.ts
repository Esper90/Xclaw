import cron from "node-cron";
import { listAllUsers } from "../../db/userStore";
import { hasUserXCreds } from "../../db/getUserClient";
import { getUserProfile } from "../../db/profileStore";

const CHECK_CRON = "0 13 * * MON"; // Mondays 13:00 UTC

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

export function startNetworkBoosterWatcher(
    sendMessage: (chatId: number, text: string, extra?: { reply_markup?: any }) => Promise<void>
): void {
    cron.schedule(CHECK_CRON, async () => {
        try {
            const users = await listAllUsers();
            if (!users || users.length === 0) return;

            for (const user of users) {
                const telegramId = user.telegram_id;
                const hasCreds = await hasUserXCreds(telegramId);
                if (!hasCreds) continue;

                const profile = await getUserProfile(telegramId);
                const prefs = (profile.prefs || {}) as Record<string, any>;
                if (prefs.networkEnabled === false) continue;
                if (isQuiet(prefs)) continue;
                const niche = (prefs as any)?.contentNiche as string | undefined;

                const message = [
                    "🤝 Network Booster (preview)",
                    niche ? `Niche: ${niche}` : "",
                    "",
                    "I'll soon scout recent followers/mentions for 3–5 collab targets and draft intros.",
                    "For now, ask: 'find collaborators in <niche>' to get quick suggestions.",
                ].filter(Boolean).join("\n");

                const reply_markup = {
                    inline_keyboard: [
                        [
                            { text: "Find collaborators", callback_data: "network:find" },
                            { text: "Snooze", callback_data: "network:snooze" },
                        ],
                    ],
                };

                try {
                    await sendMessage(telegramId, message, { reply_markup });
                    console.log(`[network-booster] Pinged ${telegramId}`);
                } catch (err) {
                    console.error(`[network-booster] Failed to ping ${telegramId}:`, err);
                }
            }
        } catch (err) {
            console.error("[network-booster] Loop failed:", err);
        }
    });

    console.log(`[network-booster] Scheduler active — cron: "${CHECK_CRON}"`);
}
