/**
 * Diagnose X Account Activity webhook subscriptions.
 * Run this to see exactly what webhooks and subscriptions are registered.
 *
 * Uses X API v2 endpoints:
 *   GET /2/webhooks                                             — list webhooks (Bearer Token)
 *   GET /2/account_activity/webhooks/:id/subscriptions/all/list — list subscriptions (Bearer Token)
 *
 * Usage:
 *   npx ts-node src/scripts/diagnoseWebhook.ts
 *
 * Optional: set TWITTER_BEARER_TOKEN in env to skip the appLogin() round-trip.
 */

import "dotenv/config";
import { TwitterApi } from "twitter-api-v2";

const {
    X_CONSUMER_KEY,
    X_CONSUMER_SECRET,
    X_ACCESS_TOKEN,
    X_ACCESS_SECRET,
    TWITTER_BEARER_TOKEN,
} = process.env;

if (!X_CONSUMER_KEY || !X_CONSUMER_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
    console.error("❌ Missing X_ env vars");
    process.exit(1);
}

async function diagnose(): Promise<void> {
    // OAuth 1.0a user-context client — for authenticated user identity
    const userClient = new TwitterApi({
        appKey: X_CONSUMER_KEY!,
        appSecret: X_CONSUMER_SECRET!,
        accessToken: X_ACCESS_TOKEN!,
        accessSecret: X_ACCESS_SECRET!,
    });

    // App-only Bearer Token client — required for v2 webhook management endpoints
    const appClient = TWITTER_BEARER_TOKEN
        ? new TwitterApi(TWITTER_BEARER_TOKEN)
        : await userClient.appLogin();

    console.log(`\n── Authenticated as ──────────────────────────────`);
    try {
        const me = await userClient.v2.me({ "user.fields": ["id", "username"] });
        console.log(`X user: @${me.data.username} (ID: ${me.data.id})`);
        console.log("⚠  This is the account whose activity will be monitored.");
        console.log("   Make sure this is the account you want DM/mention alerts for.");
    } catch (err) {
        console.error("Failed to get authenticated user:", err);
    }

    console.log(`\n── Registered webhooks (GET /2/webhooks) ──────────`);
    let firstWebhookId: string | undefined;
    try {
        // v2 endpoint — Bearer Token required
        const result = await (appClient.v2 as any).get("webhooks");
        const webhooks: any[] = result?.data ?? [];
        if (webhooks.length === 0) {
            console.log("No webhooks registered.");
            console.log("   Run: npx ts-node src/scripts/setupWebhook.ts");
        } else {
            for (const wh of webhooks) {
                firstWebhookId = wh.id;
                console.log(`  ID    : ${wh.id}`);
                console.log(`  URL   : ${wh.url}`);
                console.log(`  Valid : ${wh.valid}`);
                if (!wh.valid) {
                    console.log("  ⚠ Webhook marked invalid — X failed a CRC re-check. Re-register it.");
                }
            }
        }
    } catch (err: any) {
        console.error("Failed to list webhooks:", err?.data ?? err?.message ?? err);
    }

    console.log(`\n── Active subscriptions ──────────────────────────`);
    if (!firstWebhookId) {
        console.log("Cannot check subscriptions — no webhook ID found above.");
    } else {
        try {
            // v2 endpoint — Bearer Token required
            const subs = await (appClient.v2 as any).get(
                `account_activity/webhooks/${firstWebhookId}/subscriptions/all/list`
            );
            // Response shape: { data: { subscriptions: [...], webhook_id, webhook_url, application_id } }
            const list: any[] = subs?.data?.subscriptions ?? subs?.subscriptions ?? subs?.data ?? [];
            if (list.length === 0) {
                console.log("❌ No subscriptions — this is why events aren't being delivered!");
                console.log("   Run: npx ts-node src/scripts/setupWebhook.ts");
            } else {
                console.log(`✅ ${list.length} subscription(s) active:`);
                for (const sub of list) {
                    console.log(`  User ID: ${sub.user_id ?? sub.id ?? JSON.stringify(sub)}`);
                }
            }
        } catch (err: any) {
            console.error("Failed to list subscriptions:", err?.data ?? err?.message ?? err);
        }
    }

    console.log("\n─────────────────────────────────────────────────\n");
}

diagnose().catch((err) => {
    console.error("💥", err);
    process.exit(1);
});
