/**
 * Xclaw webhook manager
 *
 * Programmatically registers an X Account Activity API v2 webhook URL
 * and subscribes the user — called from the /setup Telegram command after
 * credentials are saved to Supabase.
 *
 * Each user gets their own webhook URL:
 *   https://<RAILWAY_URL>/x-webhook/<TELEGRAM_ID>
 *
 * X sends CRC challenges and event POST payloads to that URL.
 * The :telegramId segment lets us look up the right consumer secret (CRC)
 * and the right Telegram chat to forward events to (POST routing).
 */

import { TwitterApi } from "twitter-api-v2";
import { config } from "../config";

export interface WebhookSetupResult {
    webhookId: string;
    webhookUrl: string;
    subscribed: boolean;
}

/**
 * Register a webhook for the user's X app and subscribe the user.
 *
 * @param consumerKey     User's X app consumer key
 * @param consumerSecret  User's X app consumer secret
 * @param accessToken     User's OAuth 1.0a access token
 * @param accessSecret    User's OAuth 1.0a access secret
 * @param telegramId      Telegram ID — appended to the webhook URL path
 */
export async function registerAndSubscribeWebhook(
    consumerKey: string,
    consumerSecret: string,
    accessToken: string,
    accessSecret: string,
    telegramId: number
): Promise<WebhookSetupResult> {
    const baseUrl =
        config.RAILWAY_URL?.replace(/\/+$/, "") ??
        "https://xcue-gravityclaw-production.up.railway.app";
    const webhookUrl = `${baseUrl}/x-webhook/${telegramId}`;

    const userClient = new TwitterApi({
        appKey: consumerKey,
        appSecret: consumerSecret,
        accessToken,
        accessSecret,
    });
    const appClient = await new TwitterApi({
        appKey: consumerKey,
        appSecret: consumerSecret,
    }).appLogin();

    // ── Step 1: Look for an existing webhook registered by this app ──────────
    let webhookId: string | null = null;
    try {
        const existing = await (appClient.v2 as any).get("webhooks") as {
            data?: Array<{ id: string; url: string; valid: boolean }>;
        };
        const hooks = existing?.data ?? [];
        if (hooks.length > 0) {
            webhookId = hooks[0].id;
            const isValid = hooks[0].valid;
            console.log(`[webhookManager] Found existing webhook ${webhookId} (valid: ${isValid})`);
            if (!isValid) {
                console.log(`[webhookManager] Triggering CRC re-validation for ${webhookId}…`);
                await (appClient.v2 as any).put(`webhooks/${webhookId}`);
            }
        }
    } catch (err) {
        console.warn("[webhookManager] Could not list existing webhooks:", err);
    }

    // ── Step 2: Register if no existing webhook found ────────────────────────
    if (!webhookId) {
        console.log(`[webhookManager] Registering new webhook → ${webhookUrl}`);
        const reg = await (appClient.v2 as any).post("webhooks", { url: webhookUrl }) as {
            data?: { id: string };
        };
        webhookId = reg?.data?.id ?? null;
        if (!webhookId) {
            throw new Error("Webhook registration succeeded but response had no ID");
        }
        console.log(`[webhookManager] Registered webhook ${webhookId}`);
    }

    // ── Step 3: Subscribe the user ────────────────────────────────────────────
    let subscribed = false;
    try {
        await (userClient.v2 as any).post(
            `account_activity/webhooks/${webhookId}/subscriptions/all`
        );
        subscribed = true;
        console.log(`[webhookManager] Subscription active — telegramId=${telegramId}`);
    } catch (err: any) {
        console.error("[webhookManager] Subscription failed:", err?.message ?? err);
    }

    return { webhookId, webhookUrl, subscribed };
}
