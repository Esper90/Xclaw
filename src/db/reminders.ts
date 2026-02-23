import { getSupabase, isSupabaseConfigured } from "./userStore";

export interface Reminder {
    id: string;
    user_id: number;
    text: string;
    remind_at: string;
    status: 'pending' | 'completed' | 'failed';
    created_at: string;
}

/**
 * Creates a new reminder in the database.
 */
export async function createReminder(userId: number, text: string, remindAtISO: string): Promise<Reminder> {
    if (!isSupabaseConfigured()) {
        throw new Error("Supabase is not configured. Cannot set persistent reminders.");
    }
    const db = getSupabase();

    console.log(`[reminders] Creating reminder for user ${userId} at ${remindAtISO}`);

    const { data, error } = await db
        .from('xclaw_reminders')
        .insert({
            user_id: userId,
            text: text,
            remind_at: remindAtISO,
            status: 'pending'
        })
        .select()
        .single();

    if (error) {
        console.error("[reminders] Failed to create reminder:", error);
        throw error;
    }

    return data as Reminder;
}

/**
 * Fetches all pending reminders that are due right now (or past due).
 * Status must be 'pending' and remind_at <= NOW().
 */
export async function getDueReminders(): Promise<Reminder[]> {
    if (!isSupabaseConfigured()) return [];

    const db = getSupabase();
    const nowIso = new Date().toISOString();

    const { data, error } = await db
        .from('xclaw_reminders')
        .select('*')
        .eq('status', 'pending')
        .lte('remind_at', nowIso)
        .order('remind_at', { ascending: true });

    if (error) {
        console.error("[reminders] Failed to fetch due reminders:", error);
        return [];
    }

    return data as Reminder[];
}

/**
 * Marks a batch of reminders as completed so they don't fire again.
 */
export async function markRemindersCompleted(ids: string[]): Promise<void> {
    if (!ids.length) return;
    if (!isSupabaseConfigured()) return;

    const db = getSupabase();
    const { error } = await db
        .from('xclaw_reminders')
        .update({ status: 'completed' })
        .in('id', ids);

    if (error) {
        console.error("[reminders] Failed to update reminder status:", error);
    }
}
