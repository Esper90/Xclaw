import { getDueScheduledPosts, updateScheduledPostStatus } from "./scheduledPosts";
import { isSupabaseConfigured } from "./userStore";
import { postTweet } from "../claws/wire/xService";
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
 * for mature scheduled posts. If found, it dispatches them to X
 * and notifies the user via Telegram.
 */
export function startPostWatcher(
    sendMessage: (chatId: number, text: string) => Promise<void>
): void {
    if (!isSupabaseConfigured()) {
        console.warn("[postWatcher] Supabase not configured. Post scheduler disabled.");
        return;
    }

    console.log("[postWatcher] Starting persistent 60s post scheduler watcher...");

    setInterval(async () => {
        try {
            const duePosts = await getDueScheduledPosts();
            if (!duePosts.length) return;

            console.log(`[postWatcher] Found ${duePosts.length} due posts to publish.`);

            for (const post of duePosts) {
                try {
                    const profile = await getUserProfile(post.user_id).catch(() => null);
                    const prefs = (profile?.prefs || {}) as Record<string, any>;
                    if (isQuiet(prefs)) continue;

                    // Try to publish using the user's OAuth 1.0 credentials via xService
                    const xTweetId = await postTweet(post.text, post.user_id);
                    await updateScheduledPostStatus(post.id, 'posted');

                    await sendMessage(
                        post.user_id,
                        `✅ *Scheduled Post Published*\n\nYour tweet was successfully posted to X.\nhttps://x.com/i/web/status/${xTweetId}`
                    );
                } catch (publishErr: any) {
                    console.error(`[postWatcher] Failed to publish post for ${post.user_id}:`, publishErr);

                    await updateScheduledPostStatus(post.id, 'failed');

                    await sendMessage(
                        post.user_id,
                        `❌ *Scheduled Post Failed*\n\nI attempted to publish your scheduled tweet but encountered an error:\n_${publishErr.message || "Unknown error"}_\n\nDraft:\n${post.text}`
                    );
                }
            }
        } catch (err) {
            console.error("[postWatcher] Watcher loop error:", err);
        }
    }, 60 * 1000); // Poll every 60 seconds
}
