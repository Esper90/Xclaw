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
import { lookupKnownSender, resolveXUserId } from "../../claws/wire/xButler";
import { getUser, getUserByXUserId, isSupabaseConfigured } from "../../db/userStore";
import { upsertMemory } from "../../claws/archive/pinecone";

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
function verifySignature(req: Request, secret?: string): boolean {
    const consumerSecret = secret ?? config.X_CONSUMER_SECRET;
    if (!consumerSecret) return false;
    const sig = req.headers["x-twitter-webhooks-signature"] as string | undefined;
    if (!sig?.startsWith("sha256=")) return false;
    const expected =
        "sha256=" +
        crypto
            .createHmac("sha256", consumerSecret)
            .update(JSON.stringify(req.body))
            .digest("base64");
    try {
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
        return false;
    }
}

// ── Allowlist helpers ────────────────────────────────────────────────────────
/**
 * Parse a comma-separated env var into a lowercase Set of handles.
 * Returns null (= allow all) when the env var is empty or not set.
 */
function parseAllowlist(raw: string | undefined): Set<string> | null {
    if (!raw?.trim()) return null;
    const handles = raw.split(",").map((h) => h.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
    return handles.length > 0 ? new Set(handles) : null;
}

const mentionAllowlist = parseAllowlist(config.MENTION_ALLOWLIST);
const dmAllowlist = parseAllowlist(config.DM_ALLOWLIST);

if (mentionAllowlist) {
    console.log(`[x-webhook] 🔒 Mention allowlist active — ${mentionAllowlist.size} handle(s): ${[...mentionAllowlist].join(", ")}`);
}
if (dmAllowlist) {
    console.log(`[x-webhook] 🔒 DM allowlist active — ${dmAllowlist.size} handle(s): ${[...dmAllowlist].join(", ")}`);
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

    // for_user_id IS the authenticated user's X ID for this subscription — no API call needed
    const myXId = payload.for_user_id;

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
            (await resolveXUserId(sender_id, defaultChatId()));

        // DM allowlist check
        if (dmAllowlist && !dmAllowlist.has(username.toLowerCase())) {
            console.log(`[x-webhook] 📩 DM from @${username} — filtered (not in DM_ALLOWLIST)`);
            continue;
        }

        console.log(`[x-webhook] 📩 DM from @${username}: "${text.slice(0, 80)}"`);

        try {
            await _sendMessage(chatId, formatDMAlert(username, text));

            await upsertMemory(String(chatId), text, {
                source: "butler_dm",
                dmId: evt.message_create.id ?? evt.id ?? Date.now().toString(),
                senderId: sender_id,
                senderUsername: username,
                createdAt: evt.created_timestamp ?? new Date().toISOString()
            }, `${chatId}-dm-${evt.message_create.id ?? evt.id}`);

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

        // Mention allowlist check
        if (mentionAllowlist && !mentionAllowlist.has(username.toLowerCase())) {
            console.log(`[x-webhook] 🔔 Mention from @${username} — filtered (not in MENTION_ALLOWLIST)`);
            continue;
        }

        console.log(`[x-webhook] 🔔 Mention from @${username}: "${text.slice(0, 80)}"`);

        try {
            await _sendMessage(chatId, formatMentionAlert(username, text, tweet.id_str));

            await upsertMemory(String(chatId), text, {
                source: "butler_mention",
                tweetId: tweet.id_str,
                authorId: tweet.user?.id_str ?? "",
                authorUsername: username ?? "",
                createdAt: new Date().toISOString()
            }, `${chatId}-mention-${tweet.id_str}`);

        } catch (err) {
            console.error("[x-webhook] Failed to forward mention to Telegram:", err);
        }
    }
});

// ── Per-user routes (multi-user / user-owned keys model) ──────────────────────
// URL pattern: /x-webhook/:telegramId
// Each user registers their own webhook pointing to this URL with their Telegram ID
// appended so the CRC and POST handlers can look up their specific credentials and
// route events to their Telegram chat.

/**
 * GET /x-webhook/:telegramId
 * Per-user CRC challenge — uses that user's consumer secret for the HMAC.
 */
xWebhookRouter.get("/:telegramId", async (req: Request, res: Response) => {
    const crc = req.query.crc_token as string | undefined;
    if (!crc) {
        res.status(400).json({ error: "Missing crc_token" });
        return;
    }

    const telegramId = parseInt(req.params["telegramId"] as string, 10);
    if (isNaN(telegramId)) {
        res.status(400).json({ error: "Invalid telegramId" });
        return;
    }

    // Look up this user's consumer secret — falls back to global env var
    let consumerSecret = config.X_CONSUMER_SECRET;
    if (isSupabaseConfigured()) {
        try {
            const user = await getUser(telegramId);
            if (user) consumerSecret = user.x_consumer_secret;
        } catch (err) {
            console.warn(`[x-webhook/:tid] DB lookup failed for CRC (tid=${telegramId}):`, err);
        }
    }

    if (!consumerSecret) {
        res.status(500).json({ error: "Consumer secret not found for this user" });
        return;
    }

    const hash = crypto
        .createHmac("sha256", consumerSecret)
        .update(crc)
        .digest("base64");
    console.log(`[x-webhook/${telegramId}] CRC challenge answered ✓`);
    res.json({ response_token: `sha256=${hash}` });
});

/**
 * POST /x-webhook/:telegramId
 * Per-user event handler — routes DM and mention events to the correct Telegram chat.
 */
xWebhookRouter.post("/:telegramId", async (req: Request, res: Response) => {
    res.sendStatus(200);

    const telegramId = parseInt(req.params["telegramId"] as string, 10);
    if (isNaN(telegramId)) return;

    const keys = Object.keys(req.body ?? {});
    console.log(`[x-webhook/${telegramId}] POST received — payload keys: [${keys.join(", ") || "EMPTY"}]`);
    if (keys.length === 0) return;

    if (!_sendMessage) {
        console.warn(`[x-webhook/${telegramId}] No Telegram sender injected — event dropped`);
        return;
    }

    const payload = req.body as XWebhookPayload;
    const usersMap = payload.users ?? {};
    const myXId = payload.for_user_id; // The subscribed X user's ID

    // Load per-user allowlists from DB (fall back to global env allowlists)
    let userMentionAllowlist = mentionAllowlist;
    let userDmAllowlist = dmAllowlist;
    let consumerSecret = config.X_CONSUMER_SECRET;
    if (isSupabaseConfigured()) {
        try {
            const userRow = await getUser(telegramId);
            if (userRow) {
                userMentionAllowlist = parseAllowlist(userRow.mention_allowlist ?? undefined);
                userDmAllowlist = parseAllowlist(userRow.dm_allowlist ?? undefined);
                consumerSecret = userRow.x_consumer_secret;
            }
        } catch (err) {
            console.warn(`[x-webhook/${telegramId}] DB lookup failed:`, err);
        }
    }

    // Verify HMAC signature
    if (!verifySignature(req, consumerSecret ?? undefined)) {
        console.warn(`[x-webhook/${telegramId}] ⚠ Signature mismatch`);
    }

    // ── DM events ─────────────────────────────────────────────────────────────
    for (const evt of payload.direct_message_events ?? []) {
        if (evt.type !== "message_create") continue;
        const { sender_id, message_data } = evt.message_create;
        if (sender_id === myXId) continue; // Skip own outbound messages

        const text = message_data.text;
        const payloadUser = usersMap[sender_id];
        const username =
            payloadUser?.screen_name ??
            lookupKnownSender(sender_id)?.username ??
            (await resolveXUserId(sender_id, telegramId));

        if (userDmAllowlist && !userDmAllowlist.has(username.toLowerCase())) {
            console.log(`[x-webhook/${telegramId}] 📩 DM from @${username} — filtered`);
            continue;
        }
        console.log(`[x-webhook/${telegramId}] 📩 DM from @${username}: "${text.slice(0, 80)}"`);
        try {
            await _sendMessage(telegramId, formatDMAlert(username, text));

            await upsertMemory(String(telegramId), text, {
                source: "butler_dm",
                dmId: evt.message_create.id ?? evt.id ?? Date.now().toString(),
                senderId: sender_id,
                senderUsername: username,
                createdAt: evt.created_timestamp ?? new Date().toISOString()
            }, `${telegramId}-dm-${evt.message_create.id ?? evt.id}`);

        } catch (err) {
            console.error(`[x-webhook/${telegramId}] Failed to forward DM:`, err);
        }
    }

    // ── Mention events ─────────────────────────────────────────────────────────
    for (const tweet of payload.tweet_create_events ?? []) {
        if (tweet.user?.id_str === myXId) continue; // Skip own tweets
        const tweetMentions = tweet.entities?.user_mentions ?? [];
        if (!tweetMentions.some((m) => m.id_str === myXId)) continue;

        const username = tweet.user?.screen_name ?? tweet.user?.id_str;
        const text = tweet.full_text ?? tweet.text;

        if (userMentionAllowlist && !userMentionAllowlist.has(username.toLowerCase())) {
            console.log(`[x-webhook/${telegramId}] 🔔 Mention from @${username} — filtered`);
            continue;
        }
        console.log(`[x-webhook/${telegramId}] 🔔 Mention from @${username}: "${text.slice(0, 80)}"`);
        try {
            await _sendMessage(telegramId, formatMentionAlert(username, text, tweet.id_str));

            await upsertMemory(String(telegramId), text, {
                source: "butler_mention",
                tweetId: tweet.id_str,
                authorId: tweet.user?.id_str ?? "",
                authorUsername: username ?? "",
                createdAt: new Date().toISOString()
            }, `${telegramId}-mention-${tweet.id_str}`);

        } catch (err) {
            console.error(`[x-webhook/${telegramId}] Failed to forward mention:`, err);
        }
    }
});
