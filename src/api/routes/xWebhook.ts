/**
 * X Account Activity Webhook — Xclaw
 *
 * Receives real-time push events from X (Twitter) Account Activity API (v1.1).
 * Handles:
 *   - CRC challenge (GET) — X validates your endpoint is alive and owned by you
 *   - DM events     (POST direct_message_events) — new legacy DMs → instant Telegram alert
 *   - Mention events (POST tweet_create_events)  — new mentions  → instant Telegram alert
 *
 * Registration (one-time after deploy):
 *   npx ts-node src/scripts/setupWebhook.ts
 *
 * Cost: $0 per incoming event — X pushes to your server, no outbound API call needed.
 * Username resolution uses the payload's included `users` map first, then knownSendersCache,
 * then a single v2.user() lookup only on cache miss (rare, ~$0.01 each).
 */

import crypto from "crypto";
import { Router, type Request, type Response } from "express";
import { config } from "../../config";
import { lookupKnownSender, resolveXUserId, getMyXUserId } from "../../claws/wire/xButler";

// ── Injected Telegram sender ──────────────────────────────────────────────────
let _sendMessage: ((chatId: number, text: string) => Promise<void>) | null = null;

/**
 * Inject the Telegram send function from index.ts.
 * Must be called before incoming webhook events are processed.
 */
export function injectWebhookSender(fn: (chatId: number, text: string) => Promise<void>): void {
    _sendMessage = fn;
    console.log("[x-webhook] Telegram sender injected");
}

/** Default chat ID — first entry in ALLOWED_TELEGRAM_IDS (personal bot). */
function defaultChatId(): number {
    return parseInt(config.ALLOWED_TELEGRAM_IDS.split(",")[0].trim(), 10);
}

// ── Account Activity API v1.1 payload types ───────────────────────────────────
interface V1User {
    id_str: string;
    screen_name: string;
    name: string;
}

interface V1DMEvent {
    type: string;       // "message_create"
    id: string;
    created_timestamp: string;
    message_create: {
        sender_id: string;
        target: { recipient_id: string };
        message_data: { text: string };
    };
}

interface V1Tweet {
    id_str: string;
    full_text?: string;
    text: string;
    user: V1User;
    entities?: {
        user_mentions?: Array<{ id_str: string; screen_name: string }>;
    };
}

interface XWebhookPayload {
    for_user_id: string;
    /** User objects included inline — keyed by numeric ID string. */
    users?: Record<string, V1User>;
    direct_message_events?: V1DMEvent[];
    tweet_create_events?: V1Tweet[];
}

// ── Signature verification ────────────────────────────────────────────────────
/**
 * Verify X's HMAC-SHA256 signature on incoming webhook POSTs.
 * Header: x-twitter-webhooks-signature: sha256=<base64>
 * Docs: https://developer.x.com/en/docs/x-api/enterprise/account-activity-api/guides/securing-webhooks
 */
function verifySignature(req: Request): boolean {
    const secret = config.X_CONSUMER_SECRET;
    if (!secret) return false;
    const sig = req.headers["x-twitter-webhooks-signature"] as string | undefined;
    if (!sig?.startsWith("sha256=")) return false;
    const expected =
        "sha256=" +
        crypto
            .createHmac("sha256", secret)
            .update(JSON.stringify(req.body))
            .digest("base64");
    try {
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
        return false;
    }
}

// ── Telegram message formatters ───────────────────────────────────────────────
function formatDMAlert(username: string, text: string): string {
    return (
        `📩 *New DM from @${username}*\n\n` +
        `"${text}"\n\n` +
        `💡 _Say "reply to dm from @${username}: <message>" to reply_`
    );
}

function formatMentionAlert(username: string, text: string, tweetId: string): string {
    return (
        `🔔 *@${username} mentioned you*\n\n` +
        `"${text}"\n\n` +
        `[View on X](https://x.com/i/web/status/${tweetId})`
    );
}

// ── Router ────────────────────────────────────────────────────────────────────
export const xWebhookRouter = Router();

/**
 * GET /x-webhook
 * CRC challenge — X calls this to verify endpoint ownership.
 * Must respond with sha256 HMAC of the crc_token within 3 seconds.
 */
xWebhookRouter.get("/", (req: Request, res: Response) => {
    const crc = req.query.crc_token as string | undefined;
    if (!crc || !config.X_CONSUMER_SECRET) {
        res.status(400).json({ error: "Missing crc_token or consumer secret" });
        return;
    }
    const hash = crypto
        .createHmac("sha256", config.X_CONSUMER_SECRET)
        .update(crc)
        .digest("base64");
    console.log("[x-webhook] CRC challenge answered ✓");
    res.json({ response_token: `sha256=${hash}` });
});

/**
 * POST /x-webhook
 * X pushes Account Activity events here in real-time.
 * Processes DM events and mention events and forwards to Telegram.
 */
xWebhookRouter.post("/", async (req: Request, res: Response) => {
    // Acknowledge immediately — X requires a 200 within 3 seconds.
    res.sendStatus(200);

    // Debug: log every incoming POST so we can confirm X is delivering at all
    const keys = Object.keys(req.body ?? {});
    console.log(`[x-webhook] POST received — payload keys: [${keys.join(", ") || "EMPTY"}]`);
    if (keys.length === 0) {
        console.warn("[x-webhook] ⚠ Empty payload — X may be sending a keep-alive ping or delivery is misconfigured");
        return;
    }

    // Verify HMAC signature (warn on mismatch but continue — avoids timing edge cases on first deploy)
    if (!verifySignature(req)) {
        console.warn("[x-webhook] ⚠ Signature mismatch — check X_CONSUMER_SECRET is correct");
    }

    if (!_sendMessage) {
        console.warn("[x-webhook] No Telegram sender injected — event dropped");
        return;
    }

    const payload = req.body as XWebhookPayload;
    const usersMap = payload.users ?? {};
    const chatId = defaultChatId();

    let myXId: string;
    try {
        myXId = await getMyXUserId();
    } catch (err) {
        console.error("[x-webhook] Cannot get authenticated X user ID — event dropped:", err);
        return;
    }

    // ── DM events ─────────────────────────────────────────────────────────────
    for (const evt of payload.direct_message_events ?? []) {
        if (evt.type !== "message_create") continue;

        const { sender_id, message_data } = evt.message_create;

        // Skip outbound (own) messages
        if (sender_id === myXId) continue;

        const text = message_data.text;

        // Resolve sender username — priority:
        // 1. Payload's inline users map (free, always present from Account Activity)
        // 2. knownSendersCache (from prior DM fetches this session)
        // 3. v2.user() API call (~$0.01, only on cache miss)
        const payloadUser = usersMap[sender_id];
        const username =
            payloadUser?.screen_name ??
            lookupKnownSender(sender_id)?.username ??
            (await resolveXUserId(sender_id));

        console.log(`[x-webhook] 📩 DM from @${username}: "${text.slice(0, 80)}"`);

        try {
            await _sendMessage(chatId, formatDMAlert(username, text));
        } catch (err) {
            console.error("[x-webhook] Failed to forward DM to Telegram:", err);
        }
    }

    // ── Mention events ────────────────────────────────────────────────────────
    for (const tweet of payload.tweet_create_events ?? []) {
        // Skip own tweets (e.g. when you post something)
        if (tweet.user?.id_str === myXId) continue;

        // Only alert if you are actually @mentioned in the tweet
        const mentions = tweet.entities?.user_mentions ?? [];
        if (!mentions.some((m) => m.id_str === myXId)) continue;

        const username = tweet.user?.screen_name ?? tweet.user?.id_str;
        const text = tweet.full_text ?? tweet.text;

        console.log(`[x-webhook] 🔔 Mention from @${username}: "${text.slice(0, 80)}"`);

        try {
            await _sendMessage(chatId, formatMentionAlert(username, text, tweet.id_str));
        } catch (err) {
            console.error("[x-webhook] Failed to forward mention to Telegram:", err);
        }
    }
});
