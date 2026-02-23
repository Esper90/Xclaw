import { TwitterApi } from "twitter-api-v2";
import { config } from "../../config";
import { getUserXClient } from "../../db/getUserClient";

// ── Legacy singleton (used when no telegramId is provided) ───────────────────
let _legacyClient: TwitterApi | null = null;

async function getLegacyClient(): Promise<TwitterApi> {
    if (!config.X_CONSUMER_KEY || !config.X_CONSUMER_SECRET || !config.X_ACCESS_TOKEN || !config.X_ACCESS_SECRET) {
        throw new Error("X API credentials are not fully configured in environment variables.");
    }
    if (!_legacyClient) {
        _legacyClient = new TwitterApi({
            appKey: config.X_CONSUMER_KEY,
            appSecret: config.X_CONSUMER_SECRET,
            accessToken: config.X_ACCESS_TOKEN,
            accessSecret: config.X_ACCESS_SECRET,
        });
    }
    return _legacyClient;
}

/**
 * Post a tweet to X.
 * @param text       - The content of the tweet
 * @param telegramId - Telegram user ID whose X credentials to use (optional — falls back to env vars)
 * @param replyToId  - Optional ID of the tweet to reply to (for threads)
 */
export async function postTweet(text: string, telegramId?: string | number, replyToId?: string): Promise<string> {
    try {
        const client = telegramId
            ? await getUserXClient(telegramId)
            : await getLegacyClient();
        console.log(`[X] Attempting to post tweet: "${text.substring(0, 50)}..."${replyToId ? ` (reply to ${replyToId})` : ""}`);

        const { data: createdTweet } = await client.v2.tweet({
            text,
            ...(replyToId ? { reply: { in_reply_to_tweet_id: replyToId } } : {}),
        });

        console.log(`[X] Tweet posted successfully! ID: ${createdTweet.id}`);
        return createdTweet.id;
    } catch (error: any) {
        console.error("[X] Failed to post tweet:", error);

        if (error.code === 401) {
            throw new Error("X API Authorization failed. Check your tokens and app permissions (Read/Write).");
        }
        if (error.code === 403) {
            throw new Error("X API 403 Forbidden. Is your account suspended or does the app lack Write permissions?");
        }

        throw new Error(`X API Error: ${error.message || "Unknown error"}`);
    }
}
