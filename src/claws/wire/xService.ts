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
 * @param mediaIds   - Optional array of X media IDs to attach
 */
export async function postTweet(
    text: string,
    telegramId?: string | number,
    replyToId?: string,
    mediaIds?: string[]
): Promise<string> {
    try {
        const client = telegramId
            ? await getUserXClient(telegramId)
            : await getLegacyClient();
        console.log(`[X] Attempting to post tweet: "${text.substring(0, 50)}..."${replyToId ? ` (reply to ${replyToId})` : ""}${mediaIds ? ` (+${mediaIds.length} media)` : ""}`);

        const parameters: any = {
            text,
            ...(replyToId ? { reply: { in_reply_to_tweet_id: replyToId } } : {}),
            ...(mediaIds && mediaIds.length > 0 ? { media: { media_ids: mediaIds as [string, ...string[]] } } : {}),
        };
        const { data: createdTweet } = await client.v2.tweet(parameters);

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

/**
 * Quote Tweet a specific tweet.
 */
export async function quoteTweet(
    text: string,
    quoteTweetId: string,
    telegramId?: string | number
): Promise<string> {
    try {
        const client = telegramId
            ? await getUserXClient(telegramId)
            : await getLegacyClient();
        console.log(`[X] Attempting to quote tweet ${quoteTweetId}: "${text.substring(0, 50)}..."`);

        const parameters: any = {
            text,
            quote_tweet_id: quoteTweetId,
        };
        const { data: createdTweet } = await client.v2.tweet(parameters);

        console.log(`[X] Quote tweet posted successfully! ID: ${createdTweet.id}`);
        return createdTweet.id;
    } catch (error: any) {
        console.error("[X] Failed to quote tweet:", error);
        throw new Error(`X API Error: ${error.message || "Unknown error"}`);
    }
}

/**
 * Interact with a tweet (Like or Retweet).
 */
export async function interactWithTweet(
    tweetId: string,
    action: "like" | "retweet",
    telegramId: string | number
): Promise<void> {
    try {
        const client = await getUserXClient(telegramId);

        // Fetch the user's numeric X ID required by the v2 interaction endpoints
        const me = await client.v2.me();
        const xUserId = me.data.id;

        console.log(`[X] Attempting to ${action} tweet ${tweetId} for user ${xUserId}`);

        if (action === "like") {
            await client.v2.like(xUserId, tweetId);
        } else if (action === "retweet") {
            await client.v2.retweet(xUserId, tweetId);
        }
        console.log(`[X] ${action} successful for tweet ${tweetId}`);
    } catch (error: any) {
        console.error(`[X] Failed to ${action} tweet:`, error);
        throw new Error(`X API Error: ${error.message || "Unknown error"}`);
    }
}

/**
 * Delete a tweet.
 */
export async function deleteTweet(
    tweetId: string,
    telegramId: string | number
): Promise<void> {
    try {
        const client = await getUserXClient(telegramId);
        console.log(`[X] Attempting to delete tweet ${tweetId}`);
        await client.v2.deleteTweet(tweetId);
        console.log(`[X] Tweet ${tweetId} deleted successfully`);
    } catch (error: any) {
        console.error("[X] Failed to delete tweet:", error);
        throw new Error(`X API Error: ${error.message || "Unknown error"}`);
    }
}

/**
 * Downloads a file from Telegram using its file_id, uploads it to X's v1.1 Media API, 
 * and returns the X media_id for use in a v2 tweet.
 */
export async function uploadTelegramMediaToX(
    telegramFileId: string,
    telegramId: string | number
): Promise<string> {
    // 1. Get file path from Telegram
    const getFileUrl = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getFile?file_id=${telegramFileId}`;
    const getFileRes = await fetch(getFileUrl);
    if (!getFileRes.ok) throw new Error("Failed to call Telegram getFile API");
    const getFileJson = await getFileRes.json();
    if (!getFileJson.ok) throw new Error("Telegram getFile returned not OK");

    const filePath = getFileJson.result.file_path;
    if (!filePath) throw new Error("No file_path returned from Telegram");

    // 2. Download the actual file buffer from Telegram
    const downloadUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${filePath}`;
    const downloadRes = await fetch(downloadUrl);
    if (!downloadRes.ok) throw new Error("Failed to download file from Telegram");
    const buffer = Buffer.from(await downloadRes.arrayBuffer());

    // 3. Determine MIME type (very basic, assumes jpg/png based on extension)
    const mimeType = filePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

    // 4. Upload buffer to X
    const client = await getUserXClient(telegramId);
    console.log(`[X] Uploading media to X... (${buffer.length} bytes, ${mimeType})`);

    // v1.1 is required for media uploads, v2 handles the actual tweet
    const mediaId = await client.v1.uploadMedia(buffer, { mimeType });
    console.log(`[X] Media uploaded successfully! ID: ${mediaId}`);

    return mediaId;
}
