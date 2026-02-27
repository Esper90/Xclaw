import { getDueReminders, markRemindersCompleted } from "./reminders";
import { isSupabaseConfigured } from "./userStore";
import { getUserProfile } from "./profileStore";

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

/**
 * Starts a background loop that checks Supabase every 60 seconds
 * for mature reminders. If found, it dispatches them via Telegram
 * and marks them as completed.
 */
export function startReminderWatcher(
    sendMessage: (chatId: number, text: string) => Promise<void>
): void {
    if (!isSupabaseConfigured()) {
        console.warn("[reminders] Supabase not configured. Reminder watcher disabled.");
        return;
    }

    console.log("[reminders] Starting persistent 60s reminder watcher...");

    setInterval(async () => {
        try {
            const dueReminders = await getDueReminders();
            if (!dueReminders.length) return;

            console.log(`[reminders] Found ${dueReminders.length} due reminders to dispatch.`);

            const dispatchedIds: string[] = [];

            for (const reminder of dueReminders) {
                try {
                    const profile = await getUserProfile(reminder.user_id).catch(() => null);
                    const prefs = (profile?.prefs || {}) as Record<string, any>;
                    if (isQuiet(prefs)) continue;

                    await sendMessage(
                        reminder.user_id,
                        `⏰ *Reminder:*\n\n${reminder.text}`
                    );
                    dispatchedIds.push(reminder.id);
                } catch (sendErr) {
                    console.error(`[reminders] Failed to dispatch to ${reminder.user_id}:`, sendErr);
                    // We don't mark as completed if it failed to send, so it retries next minute.
                }
            }

            // Mark the ones we successfully sent so they don't fire again
            await markRemindersCompleted(dispatchedIds);

        } catch (err) {
            console.error("[reminders] Watcher loop error:", err);
        }
    }, 60 * 1000); // Poll every 60 seconds
}
