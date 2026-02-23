/**
 * X Account Activity Webhook — One-Time Setup Script
 *
 * Run this ONCE after deploying to Railway to register your webhook URL
 * with X and subscribe your account to receive real-time events.
 *
 * Usage:
 *   # With Railway URL auto-detected from env:
 *   RAILWAY_WEBHOOK_URL=https://xcue-gravityclaw-production.up.railway.app \
 *     npx ts-node src/scripts/setupWebhook.ts
 *
 *   # Or set it in your .env and just run:
 *   npx ts-node src/scripts/setupWebhook.ts
 *
 * What it does:
 *   1. POST /2/webhooks?url=<URL>  (Bearer Token / OAuth2 App-Only)
 *      → Registers https://<RAILWAY_URL>/x-webhook as the endpoint
 *      → X immediately sends a CRC GET to verify it — your deployed server must be live
 *   2. POST /2/account_activity/webhooks/:id/subscriptions/all  (OAuth 1.0a User Context)
 *      → Subscribes the authenticated user's activity
 *      → From this point, X pushes DMs, mentions, follows, likes in real-time
 *
 * Prerequisites:
 *   - Bot deployed and running on Railway (CRC check happens immediately)
 *   - X App has Account Activity API access (Developer Portal → Products)
 *   - All X_ env vars set: X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
 *   - Optional: TWITTER_BEARER_TOKEN (skips appLogin() round-trip for registration)
 *
 * To list or delete existing webhooks:
 *   GET    /2/webhooks
 *   DELETE /2/webhooks/:webhook_id
 */

import "dotenv/config";
import { TwitterApi } from "twitter-api-v2";

// ── Config ────────────────────────────────────────────────────────────────────
const RAILWAY_URL =
    process.env.RAILWAY_WEBHOOK_URL?.replace(/\/$/, "") ??
    (process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : null);

if (!RAILWAY_URL) {
    console.error(
        "❌ Set RAILWAY_WEBHOOK_URL env var.\n" +
        "   Example: RAILWAY_WEBHOOK_URL=https://xcue-gravityclaw-production.up.railway.app"
    );
    process.exit(1);
}

const {
    X_CONSUMER_KEY,
    X_CONSUMER_SECRET,
    X_ACCESS_TOKEN,
    X_ACCESS_SECRET,
    TWITTER_BEARER_TOKEN,
} = process.env;

if (!X_CONSUMER_KEY || !X_CONSUMER_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
    console.error("❌ Missing one or more X_ env vars. Need: X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET");
    process.exit(1);
}

const webhookUrl = `${RAILWAY_URL}/x-webhook`;

// ── Setup ─────────────────────────────────────────────────────────────────────
async function setup(): Promise<void> {
    // OAuth 1.0a user-context client — for identity check + subscription
    const userClient = new TwitterApi({
        appKey: X_CONSUMER_KEY!,
        appSecret: X_CONSUMER_SECRET!,
        accessToken: X_ACCESS_TOKEN!,
        accessSecret: X_ACCESS_SECRET!,
    });

    // App-only Bearer Token client — required for POST /2/webhooks registration
    const appClient = TWITTER_BEARER_TOKEN
        ? new TwitterApi(TWITTER_BEARER_TOKEN)
        : await userClient.appLogin();

    console.log(`\n🔗 Webhook URL : ${webhookUrl}`);
    console.log(`\n─────────────────────────────────────────`);

    // Step 1: Register webhook (or reuse existing) — POST /2/webhooks (Bearer Token)
    console.log("\n[1/2] Checking / registering webhook...");

    let webhookId: string;

    // Check for an existing registered webhook first
    try {
        const existing = await (appClient.v2 as any).get("webhooks");
        const webhooks: any[] = existing?.data ?? [];
        const match = webhooks.find((w: any) => w.url === webhookUrl) ?? webhooks[0];
        if (match) {
            webhookId = match.id;
            console.log(`✅ Webhook already registered — ID: ${webhookId} (valid: ${match.valid})`);
            if (!match.valid) {
                console.log("  ⚠ Webhook marked invalid — triggering CRC re-validation...");
                await (appClient.v2 as any).put(`webhooks/${webhookId}`);
                console.log("  CRC re-sent.");
            }
        } else {
            throw new Error("no existing webhooks");
        }
    } catch (_existingErr) {
        // No existing webhook — register a new one
        console.log("      No existing webhook — registering new (X will send a CRC ping)...");
        try {
            const result = await (appClient.v2 as any).post(
                "webhooks",
                undefined,
                { query: { url: webhookUrl } }
            );
            webhookId = result?.data?.id ?? result?.id;
            if (!webhookId) throw new Error("No webhook ID in response: " + JSON.stringify(result));
            console.log(`✅ Webhook registered — ID: ${webhookId}`);
        } catch (err: any) {
            const data = err?.data ?? err?.message ?? err;
            console.error("\n❌ Webhook registration failed:", JSON.stringify(data, null, 2));
            console.log("\nCommon causes:");
            console.log("  • Bot not deployed / CRC check failed — deploy first, then run this script");
            console.log("  • App doesn't have Account Activity API enabled (Developer Portal → Products)");
            process.exit(1);
        }
    }

    // Step 2: Subscribe user — POST /2/account_activity/webhooks/:id/subscriptions/all (OAuth 1.0a)
    console.log("\n[2/2] Subscribing your X account to the webhook...");
    try {
        await (userClient.v2 as any).post(
            `account_activity/webhooks/${webhookId}/subscriptions/all`
        );
        console.log("✅ Subscription active!");
    } catch (err: any) {
        const data = err?.data ?? err?.message ?? err;
        console.error("\n❌ Subscription failed:", JSON.stringify(data, null, 2));
        console.log("\nWebhook was registered (ID:", webhookId, ") but subscription failed.");
        process.exit(1);
    }

    console.log("\n─────────────────────────────────────────");
    console.log("🎉 Done! X will now push events to your bot in real-time.");
    console.log("\nEvents you'll receive:");
    console.log("  📩 direct_message_events — new legacy DMs (non-encrypted)");
    console.log("  🔔 tweet_create_events   — new mentions/replies");
    console.log("  👥 follow_events         — new followers");
    console.log("  ❤️  favorite_events      — likes on your tweets");
    console.log("\nTo verify everything is wired up, send yourself a DM on X and watch Railway logs.");
}

setup().catch((err) => {
    console.error("💥 Unexpected error:", err);
    process.exit(1);
});
