import { TwitterApi } from "twitter-api-v2";
import { config } from "../../config";

// Singleton client to avoid multiple re-initializations
let clientPromise: Promise<TwitterApi> | null = null;

/**
 * Initialize and return the Twitter API client.
 * Uses Consumer Key/Secret + Access Token/Secret for OAuth 1.0a User Context.
 * Required for posting tweets on behalf of a user.
 */
async function getXClient(): Promise<TwitterApi> {
    if (!config.X_CONSUMER_KEY || !config.X_CONSUMER_SECRET || !config.X_ACCESS_TOKEN || !config.X_ACCESS_SECRET) {
        throw new Error("X API credentials are not fully configured in environment variables.");
    }

    const client = new TwitterApi({
        appKey: config.X_CONSUMER_KEY,
        appSecret: config.X_CONSUMER_SECRET,
        accessToken: config.X_ACCESS_TOKEN,
        accessSecret: config.X_ACCESS_SECRET,
    });

    return client;
}

/**
 * Post a tweet to X.
 * @param text - The content of the tweet
 * @param replyToId - Optional ID of the tweet to reply to (for threads)
 */
export async function postTweet(text: string, replyToId?: string): Promise<string> {
    try {
        const client = await getXClient();
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
