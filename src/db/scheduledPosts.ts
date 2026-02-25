import { getSupabase, isSupabaseConfigured } from "./userStore";

export interface ScheduledPost {
    id: string;
    user_id: number;
    text: string;
    post_at: string;
    status: 'pending' | 'posted' | 'failed' | 'canceled';
    created_at: string;
}

/**
 * Creates a new scheduled post in the database.
 */
export async function createScheduledPost(userId: number, text: string, postAtISO: string): Promise<ScheduledPost> {
    if (!isSupabaseConfigured()) {
        throw new Error("Supabase is not configured. Cannot schedule posts.");
    }
    const db = getSupabase();

    console.log(`[scheduledPosts] Creating post for user ${userId} at ${postAtISO}`);

    const { data, error } = await db
        .from('xclaw_scheduled_posts')
        .insert({
            user_id: userId,
            text: text,
            post_at: postAtISO,
            status: 'pending'
        })
        .select()
        .single();

    if (error) {
        console.error("[scheduledPosts] Failed to create scheduled post:", error);
        throw error;
    }

    return data as ScheduledPost;
}

/**
 * Fetches all pending scheduled posts that are due to be published right now (or past due).
 * Status must be 'pending' and post_at <= NOW().
 */
export async function getDueScheduledPosts(): Promise<ScheduledPost[]> {
    if (!isSupabaseConfigured()) return [];

    const db = getSupabase();
    const nowIso = new Date().toISOString();

    const { data, error } = await db
        .from('xclaw_scheduled_posts')
        .select('*')
        .eq('status', 'pending')
        .lte('post_at', nowIso)
        .order('post_at', { ascending: true });

    if (error) {
        console.error("[scheduledPosts] Failed to fetch due scheduled posts:", error);
        return [];
    }

    return (data || []) as ScheduledPost[];
}

/**
 * Updates the status of a scheduled post (e.g. from 'pending' to 'posted' or 'failed').
 */
export async function updateScheduledPostStatus(
    id: string,
    status: 'posted' | 'failed' | 'canceled'
): Promise<void> {
    if (!isSupabaseConfigured()) return;

    const db = getSupabase();
    const { error } = await db
        .from('xclaw_scheduled_posts')
        .update({ status })
        .eq('id', id);

    if (error) {
        console.error(`[scheduledPosts] Failed to update post ${id} status to ${status}:`, error);
    }
}

/**
 * Fetches upcoming pending posts for a specific user (useful for a /scheduled command
 * if we ever want to let them list their queue).
 */
export async function getUpcomingPostsForUser(userId: number): Promise<ScheduledPost[]> {
    if (!isSupabaseConfigured()) return [];

    const db = getSupabase();
    const { data, error } = await db
        .from('xclaw_scheduled_posts')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'pending')
        .order('post_at', { ascending: true })
        .limit(10); // arbitrary limit for UI

    if (error) {
        console.error(`[scheduledPosts] Failed to fetch upcoming posts for user ${userId}:`, error);
        return [];
    }

    return (data || []) as ScheduledPost[];
}
