import cron from "node-cron";
import { listAllUsers } from "../../db/userStore";
import { getUserProfile, updateUserProfile } from "../../db/profileStore";
import { hasUserXCreds } from "../../db/getUserClient";

const CHECK_CRON = "0 * * * *"; // top of every hour
const DEFAULT_FREQ_DAYS = 3;
const QUIET_HOURS = { start: 7, end: 22 }; // local hours (inclusive start, exclusive end)

function withinQuietWindow(timezone: string | null | undefined): boolean {
    const tz = timezone || "UTC";
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        hour: "2-digit",
    });
    const hour = parseInt(formatter.formatToParts(now).find((p) => p.type === "hour")?.value ?? "0", 10);
    return hour >= QUIET_HOURS.start && hour < QUIET_HOURS.end;
}

function shouldSend(lastSent: string | undefined | null, freqDays: number): boolean {
    if (!lastSent) return true;
    const delta = Date.now() - Date.parse(lastSent);
    return delta >= freqDays * 24 * 60 * 60 * 1000;
}

export function startVibeCheckWatcher(
    sendMessage: (chatId: number, text: string, extra?: { reply_markup?: any }) => Promise<void>
): void {
    cron.schedule(CHECK_CRON, async () => {
        try {
            const users = await listAllUsers();
            if (!users || users.length === 0) return;

            for (const user of users) {
                const telegramId = user.telegram_id;
                const profile = await getUserProfile(telegramId);
                const freqDays = profile.vibeCheckFreqDays ?? DEFAULT_FREQ_DAYS;
                const prefs = (profile.prefs ?? {}) as Record<string, any>;
                const lastSent = prefs.vibeLastSentAt as string | undefined;

                if (!withinQuietWindow(profile.timezone)) continue;
                if (!shouldSend(lastSent, freqDays)) continue;

                const hasX = await hasUserXCreds(telegramId);

                const message = [
                    "🧭 Vibe Check",
                    "How are you feeling today?",
                    hasX
                        ? "I can factor in recent X activity if you want a pulse read."
                        : "Connect X via /setup to include recent X activity in these check-ins.",
                    "",
                    "Tap a choice below.",
                ]
                    .filter(Boolean)
                    .join("\n");

                const reply_markup = {
                    inline_keyboard: [
                        [
                            { text: "Yes — schedule recharge", callback_data: "vibe:yes" },
                        ],
                        [
                            { text: "No — stay focused", callback_data: "vibe:no" },
                            { text: "Later", callback_data: "vibe:later" },
                        ],
                    ],
                };

                try {
                    await sendMessage(telegramId, message, { reply_markup });
                    await updateUserProfile(telegramId, {
                        prefs: { ...prefs, vibeLastSentAt: new Date().toISOString() },
                    });
                    console.log(`[vibe-check] Sent to ${telegramId} (freq=${freqDays}d, hasX=${hasX})`);
                } catch (err) {
                    console.error(`[vibe-check] Failed to send to ${telegramId}:`, err);
                }
            }
        } catch (err) {
            console.error("[vibe-check] Loop failed:", err);
        }
    });

    console.log(`[vibe-check] Scheduler active — cron: "${CHECK_CRON}"`);
}
