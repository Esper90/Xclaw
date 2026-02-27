import cron from "node-cron";
import { listAllUsers } from "../../db/userStore";
import { getUserProfile } from "../../db/profileStore";

const CHECK_CRON = "15 17 * * *"; // daily 17:15 UTC

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

export function startHabitNudgerWatcher(
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
                if (isQuiet(prefs)) continue;

                const habits = Array.isArray(prefs.habits) ? prefs.habits : [];
                if (!habits.length) continue;

                const log = (prefs as any)?.habitLog || {};
                const today = new Date().toISOString().slice(0, 10);

                const lines = habits.slice(0, 4).map((h: any, idx: number) => {
                    const name = h.name || `Habit ${idx + 1}`;
                    const target = h.targetPerDay ? ` (${h.targetPerDay}${h.unit ? " " + h.unit : ""}/day)` : "";
                    const key = name.toLowerCase();
                    const entry = log[key] && log[key].date === today ? log[key] : null;
                    const progress = entry ? ` — today: ${entry.total}${h.unit ? " " + h.unit : ""}` : "";
                    return `${idx + 1}. ${name}${target}${progress}`;
                });

                const message = [
                    "📅 Habit Nudger",
                    "Quick check-in on your daily habits:",
                    "",
                    ...lines,
                    "",
                    "Buttons: Mark done | +15m | Snooze",
                ].filter(Boolean).join("\n");

                const reply_markup = {
                    inline_keyboard: habits.slice(0, 4).map((h: any, idx: number) => [
                        { text: `Done (${idx + 1})`, callback_data: `habit:done:${idx}` },
                        { text: `+15${(h.unit || "m").includes("min") ? "m" : ""}`, callback_data: `habit:add:${idx}` },
                        { text: "Snooze", callback_data: `habit:snooze:${idx}` },
                    ]),
                };

                try {
                    await sendMessage(telegramId, message, { reply_markup });
                    console.log(`[habit-nudger] Sent nudges to ${telegramId}`);
                } catch (err) {
                    console.error(`[habit-nudger] Failed to send to ${telegramId}:`, err);
                }
            }
        } catch (err) {
            console.error("[habit-nudger] Loop failed:", err);
        }
    });

    console.log(`[habit-nudger] Scheduler active — cron: "${CHECK_CRON}"`);
}
