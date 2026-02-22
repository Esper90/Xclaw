/**
 * Diagnose X Account Activity webhook subscriptions.
 * Run this to see exactly what webhooks and subscriptions are registered.
 *
 * Usage:
 *   npx ts-node src/scripts/diagnoseWebhook.ts
 */

import "dotenv/config";
import { TwitterApi } from "twitter-api-v2";

const {
    X_CONSUMER_KEY,
    X_CONSUMER_SECRET,
    X_ACCESS_TOKEN,
    X_ACCESS_SECRET,
    X_WEBHOOK_ENV,
} = process.env;

if (!X_CONSUMER_KEY || !X_CONSUMER_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
    console.error("❌ Missing X_ env vars");
    process.exit(1);
}

const env = X_WEBHOOK_ENV ?? "prod";

async function diagnose(): Promise<void> {
    const client = new TwitterApi({
        appKey: X_CONSUMER_KEY!,
        appSecret: X_CONSUMER_SECRET!,
        accessToken: X_ACCESS_TOKEN!,
        accessSecret: X_ACCESS_SECRET!,
    });

    console.log(`\n── Authenticated as ──────────────────────────────`);
    try {
        const me = await client.v2.me({ "user.fields": ["id", "username"] });
        console.log(`X user: @${me.data.username} (ID: ${me.data.id})`);
        console.log("⚠  This is the account whose activity will be monitored.");
        console.log("   Make sure this is the account you want DM/mention alerts for.");
    } catch (err) {
        console.error("Failed to get authenticated user:", err);
    }

    console.log(`\n── Registered webhooks (env: ${env}) ──────────────`);
    try {
        const webhooks = await (client.v1 as any).get(
            `account_activity/all/${env}/webhooks.json`
        );
        if (!webhooks || webhooks.length === 0) {
            console.log("No webhooks registered.");
        } else {
            for (const wh of webhooks) {
                console.log(`  ID    : ${wh.id}`);
                console.log(`  URL   : ${wh.url}`);
                console.log(`  Valid : ${wh.valid}`);
            }
        }
    } catch (err: any) {
        console.error("Failed to list webhooks:", err?.data ?? err?.message ?? err);
    }

    console.log(`\n── Active subscriptions ──────────────────────────`);
    try {
        const subs = await (client.v1 as any).get(
            `account_activity/all/${env}/subscriptions/list.json`
        );
        const list = subs?.subscriptions ?? [];
        if (list.length === 0) {
            console.log("❌ No subscriptions — this is why events aren't being delivered!");
            console.log("   Run: npx ts-node src/scripts/setupWebhook.ts");
        } else {
            console.log(`${list.length} subscription(s):`);
            for (const sub of list) {
                console.log(`  User ID: ${sub.user_id}`);
            }
        }
    } catch (err: any) {
        console.error("Failed to list subscriptions:", err?.data ?? err?.message ?? err);
        console.log("\nNote: Listing all subscriptions may require OAuth 2 App-only Bearer token.");
        console.log("Try checking your subscription status in the X Developer Console instead:");
        console.log("  https://developer.x.com/en/portal/dashboard → your app → Account Activity");
    }

    console.log("\n─────────────────────────────────────────────────\n");
}

diagnose().catch((err) => {
    console.error("💥", err);
    process.exit(1);
});
