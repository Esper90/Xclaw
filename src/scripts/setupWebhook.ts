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
 *   1. Calls POST /1.1/account_activity/all/{env}/webhooks.json
 *      → Registers https://<RAILWAY_URL>/x-webhook as the endpoint
 *      → X immediately sends a CRC GET to verify it — your deployed server must be live
 *   2. Calls POST /1.1/account_activity/all/{env}/subscriptions.json
 *      → Subscribes the authenticated user's activity
 *      → From this point, X pushes DMs, mentions, follows, likes in real-time
 *
 * Prerequisites:
 *   - Bot deployed and running on Railway (CRC check happens immediately)
 *   - X App has Account Activity API access (Developer Portal → Products)
 *   - All X_ env vars set: X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
 *
 * To list or delete existing webhooks:
 *   GET  /1.1/account_activity/all/{env}/webhooks.json
 *   DELETE /1.1/account_activity/all/{env}/webhooks/{webhook_id}.json
 */

import "dotenv/config";
import { TwitterApi } from "twitter-api-v2";

// ── Config ────────────────────────────────────────────────────────────────────
const RAILWAY_URL =
    process.env.RAILWAY_WEBHOOK_URL?.replace(/\/$/, "") ??
    process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : null;

const WEBHOOK_ENV = process.env.X_WEBHOOK_ENV ?? "prod";

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
} = process.env;

if (!X_CONSUMER_KEY || !X_CONSUMER_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
    console.error("❌ Missing one or more X_ env vars. Need: X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET");
    process.exit(1);
}

const webhookUrl = `${RAILWAY_URL}/x-webhook`;

// ── Setup ─────────────────────────────────────────────────────────────────────
async function setup(): Promise<void> {
    const client = new TwitterApi({
        appKey: X_CONSUMER_KEY!,
        appSecret: X_CONSUMER_SECRET!,
        accessToken: X_ACCESS_TOKEN!,
        accessSecret: X_ACCESS_SECRET!,
    });

    console.log(`\n🔗 Webhook URL : ${webhookUrl}`);
    console.log(`📦 Environment : ${WEBHOOK_ENV}`);
    console.log(`\n─────────────────────────────────────────`);

    // Step 1: Register webhook
    console.log("\n[1/2] Registering webhook with X...");
    console.log("      (X will send a CRC ping to your server — make sure it's online)");

    let webhookId: string;
    try {
        // twitter-api-v2's v1.post sends signed OAuth 1.0a requests to /1.1/ endpoints
        const result = await (client.v1 as any).post(
            `account_activity/all/${WEBHOOK_ENV}/webhooks.json`,
            { url: webhookUrl }
        );
        webhookId = result.id;
        console.log(`✅ Webhook registered — ID: ${webhookId}`);
    } catch (err: any) {
        const data = err?.data ?? err?.message ?? err;
        console.error("\n❌ Webhook registration failed:", JSON.stringify(data, null, 2));
        console.log("\nCommon causes:");
        console.log("  • Bot not deployed / CRC check failed — deploy first, then run this script");
        console.log("  • App doesn't have Account Activity API enabled (Developer Portal → Products)");
        console.log("  • Webhook already registered — list existing: GET /1.1/account_activity/all/prod/webhooks.json");
        process.exit(1);
    }

    // Step 2: Subscribe user
    console.log("\n[2/2] Subscribing your X account to the webhook...");
    try {
        await (client.v1 as any).post(
            `account_activity/all/${WEBHOOK_ENV}/subscriptions.json`,
            {}
        );
        console.log("✅ Subscription active!");
    } catch (err: any) {
        const data = err?.data ?? err?.message ?? err;
        console.error("\n❌ Subscription failed:", JSON.stringify(data, null, 2));
        console.log("\nWebhook was registered (ID:", webhookId, ") but subscription failed.");
        console.log("You can retry just the subscription with:");
        console.log(`  curl -X POST 'https://api.twitter.com/1.1/account_activity/all/${WEBHOOK_ENV}/subscriptions.json' --oauth ...`);
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
