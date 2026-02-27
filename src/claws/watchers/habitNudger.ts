import cron from "node-cron";
import { listAllUsers } from "../../db/userStore";
import { getUserProfile } from "../../db/profileStore";
import { getLocalDayKey, getLocalHour } from "../sense/time";

const CHECK_CRON = "15 17 * * *"; // daily 17:15 UTC
const PAGE_SIZE = 4;

function isQuiet(prefs: Record<string, any>, timezone: string | null | undefined): boolean {
    if ((prefs as any).quietAll) return true;
    const start = Number(prefs.quietHoursStart);
    const end = Number(prefs.quietHoursEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    if (start === end) return false;
    const hour = getLocalHour(timezone);
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
                if (prefs.habitsEnabled === false) continue;
                if (isQuiet(prefs, profile.timezone)) continue;

                const habits = Array.isArray(prefs.habits) ? prefs.habits : [];
                if (!habits.length) continue;

                const log = (prefs as any)?.habitLog || {};
                const today = getLocalDayKey(profile.timezone);

                const page = 0; // single page for now; extend with pagination callback if needed

                const lines = habits.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE).map((h: any, idx: number) => {
                    const name = h.name || `Habit ${page * PAGE_SIZE + idx + 1}`;
                    const target = h.targetPerDay ? ` (${h.targetPerDay}${h.unit ? " " + h.unit : ""}/day)` : "";
                    const key = name.trim().toLowerCase();
                    const entry = log[key] && log[key].date === today ? log[key] : null;
                    const progress = entry ? ` — today: ${entry.total}${h.unit ? " " + h.unit : ""}` : "";
                    return `${page * PAGE_SIZE + idx + 1}. ${name}${target}${progress}`;
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
                    inline_keyboard: habits.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE).map((h: any, idx: number) => {
                        const displayUnit = (h.unit || "min").toLowerCase();
                        const addLabel = displayUnit.includes("h") ? "+1h" : displayUnit.includes("min") ? "+15m" : "+1";
                        return [
                            { text: `Done (${page * PAGE_SIZE + idx + 1})`, callback_data: `habit:done:${page * PAGE_SIZE + idx}` },
                            { text: addLabel, callback_data: `habit:add:${page * PAGE_SIZE + idx}` },
                            { text: "Snooze", callback_data: `habit:snooze:${page * PAGE_SIZE + idx}` },
                        ];
                    }),
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
