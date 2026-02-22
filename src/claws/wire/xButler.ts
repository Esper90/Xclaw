/**
 * X Butler — Xclaw
 * 
 * Intelligent, low-cost assistant for X mentions and DMs.
 * Uses Pinecone semantic memory to filter only relevant items and
 * Gemini to generate concise reply suggestions.
 *
 * X API v2 endpoints used:
 *   GET  /2/users/:id/mentions          → fetch recent mentions
 *   GET  /2/dm_events                   → fetch DM events (requires dm.read on app)
 *   POST /2/tweets                      → reply to a mention
 *   POST /2/dm_conversations/:id/messages → reply to a DM thread
 *
 * OAuth note:
 *   All endpoints work with OAuth 1.0a User Context if the X Developer App
 *   has tweet.read + tweet.write + dm.read + dm.write permissions enabled.
 *   If DM calls return 403, enable DM permissions in the developer portal
 *   (Settings → App permissions → "Read and write and Direct messages").
 */

import { TwitterApi } from "twitter-api-v2";
import type { UserV2, TweetV2 } from "twitter-api-v2";

/** Minimal shape from GET /2/dm_events — DMEventV2 is not re-exported by twitter-api-v2's public index. */
type LocalDMEvent = {
    id: string;
    event_type?: string;
    text?: string;
    sender_id?: string;
    dm_conversation_id?: string;
    created_at?: string;
};
import cron from "node-cron";
import { config } from "../../config";
import { queryMemory, upsertMemory } from "../archive/pinecone";
import { getRecentlyActiveUsers } from "../sense/activityTracker";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ── Tuning constants ──────────────────────────────────────────────────────────
/** Pinecone cosine-similarity threshold to consider a mention "relevant". */
const MEMORY_RELEVANCE_THRESHOLD = 0.72;
/** Sum of likes + retweets + replies that makes a mention worth alerting even
 *  without memory relevance (someone is engaging with you seriously). */
const ENGAGEMENT_ALERT_THRESHOLD = 10;
/** Maximum suggested replies generated per call — keeps Gemini costs low. */
const MAX_REPLY_SUGGESTIONS = 3;

// ── Singleton X client ────────────────────────────────────────────────────────
let _client: TwitterApi | null = null;
let _myXUserId: string | null = null;

function getClient(): TwitterApi {
    if (!config.X_CONSUMER_KEY || !config.X_CONSUMER_SECRET ||
        !config.X_ACCESS_TOKEN || !config.X_ACCESS_SECRET) {
        throw new Error(
            "X API credentials not configured. " +
            "Set X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET in .env"
        );
    }
    if (!_client) {
        _client = new TwitterApi({
            appKey: config.X_CONSUMER_KEY,
            appSecret: config.X_CONSUMER_SECRET,
            accessToken: config.X_ACCESS_TOKEN,
            accessSecret: config.X_ACCESS_SECRET,
        });
    }
    return _client;
}

/** Returns the authenticated user's numeric X user ID (cached after first call). */
async function getMyXUserId(): Promise<string> {
    if (_myXUserId) return _myXUserId;
    const client = getClient();
    const { data } = await client.v2.me({ "user.fields": ["id", "username"] });
    _myXUserId = data.id;
    console.log(`[butler] Authenticated as X user @${data.username} (${data.id})`);
    return _myXUserId;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface ButlerMention {
    id: string;
    text: string;
    authorId: string;
    authorUsername?: string;
    /** True when the author has a legacy verified badge. */
    authorVerified: boolean;
    createdAt?: string;
    /** likes + retweets + replies */
    engagement: number;
    /** Highest Pinecone cosine-similarity score against user's memories. 0–1. */
    importanceScore: number;
    /** Short snippets of matched memories for contextual display. */
    matchedMemories: string[];
    /** AI-generated reply draft (null when cheapMode = true). */
    suggestedReply?: string;
}

export interface ButlerDM {
    id: string;
    conversationId: string;
    text: string;
    senderId: string;
    senderUsername?: string;
    createdAt?: string;
    importanceScore: number;
    matchedMemories: string[];
    suggestedReply?: string;
}

export interface ButlerReplyResult {
    success: boolean;
    /** ID of the posted tweet or DM event. */
    resultId?: string;
    /** Pinecone memory record ID for this reply. */
    memoryId?: string;
    error?: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Query Pinecone for memory relevance.
 * Returns the top cosine score and the most relevant memory snippets.
 */
async function scoreRelevance(
    xcUserId: string,
    text: string
): Promise<{ score: number; memories: string[] }> {
    try {
        const results = await queryMemory(xcUserId, text, 3);
        if (results.length === 0) return { score: 0, memories: [] };

        const relevant = results.filter(r => r.score >= MEMORY_RELEVANCE_THRESHOLD);
        return {
            score: results[0].score,
            memories: relevant.map(r => r.text.slice(0, 120)),
        };
    } catch (err) {
        console.warn("[butler] Pinecone relevance check failed:", err);
        return { score: 0, memories: [] };
    }
}

/**
 * Generate a concise reply suggestion for a single mention/DM.
 * Single Gemini call, max 240 chars output.
 */
async function suggestReply(
    originalText: string,
    contextMemories: string[],
    isDM = false
): Promise<string> {
    const ai = new GoogleGenerativeAI(config.GEMINI_API_KEY);
    const model = ai.getGenerativeModel({ model: config.GEMINI_MODEL });

    const memCtx = contextMemories.length > 0
        ? `\nPersonal context (relevant memories):\n${contextMemories.map(m => `• ${m}`).join("\n")}`
        : "";

    const kind = isDM ? "direct message" : "public tweet mention";
    const charLimit = isDM ? 10000 : 280;

    const result = await model.generateContent(
        `You are helping draft a reply to a ${kind}. Be authentic, direct, and brief.\n\n` +
        `${kind.charAt(0).toUpperCase() + kind.slice(1)} to reply to:\n"${originalText}"` +
        `${memCtx}\n\n` +
        `Write ONLY the reply text. No quotes, no labels. Max ${charLimit} characters. ` +
        `No hashtags unless they appear naturally. Be personal, not corporate.`
    );
    return result.response.text().trim();
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Fetch recent @mentions for the authenticated X user.
 * Filters for importance using Pinecone memory, engagement, and verification.
 *
 * @param xcUserId    Pinecone namespace (the authenticated user's Telegram ID).
 * @param limit       Max tweets to retrieve from X (1–100, default 10).
 * @param since       ISO-8601 timestamp OR tweet ID to use as `start_time` /
 *                    `since_id` boundary. When omitted, X returns ~7 days.
 * @param cheapMode   If true, skip reply suggestion calls (background use).
 */
export async function fetchMentions(
    xcUserId: string,
    limit = 10,
    since?: string,
    cheapMode = false
): Promise<ButlerMention[]> {
    const client = getClient();
    const xUserId = await getMyXUserId();

    const params: Parameters<typeof client.v2.userMentionTimeline>[1] = {
        max_results: Math.min(Math.max(limit, 5), 100) as any,
        "tweet.fields": ["created_at", "author_id", "public_metrics", "text"],
        expansions: ["author_id"],
        "user.fields": ["verified", "public_metrics", "username"],
    };

    // Decide how to bound the time range
    if (since) {
        // Looks like an ISO date string
        if (since.includes("-") || since.includes("T")) {
            (params as any).start_time = new Date(since).toISOString();
        } else {
            // Treat as a tweet ID
            (params as any).since_id = since;
        }
    }

    const timeline = await client.v2.userMentionTimeline(xUserId, params);
    const tweets: TweetV2[] = timeline.data?.data ?? [];
    const usersMap = new Map<string, UserV2>(
        (timeline.data?.includes?.users ?? []).map(u => [u.id, u])
    );

    if (tweets.length === 0) return [];

    // ── Filter loop ───────────────────────────────────────────────────────────
    const important: ButlerMention[] = [];
    let replyCount = 0;

    for (const tweet of tweets) {
        const pm = tweet.public_metrics;
        const engagement = pm
            ? (pm.reply_count ?? 0) + (pm.retweet_count ?? 0) + (pm.like_count ?? 0)
            : 0;

        const author = usersMap.get(tweet.author_id ?? "");
        const isVerified = author?.verified ?? false;
        const hasHighEngagement = engagement >= ENGAGEMENT_ALERT_THRESHOLD;

        // Always score via Pinecone — cheap embedding call
        const { score, memories } = await scoreRelevance(xcUserId, tweet.text);
        const isMemoryRelevant = score >= MEMORY_RELEVANCE_THRESHOLD;

        if (!isMemoryRelevant && !hasHighEngagement && !isVerified) continue;

        let suggestedReply: string | undefined;
        if (!cheapMode && replyCount < MAX_REPLY_SUGGESTIONS) {
            try {
                suggestedReply = await suggestReply(tweet.text, memories, false);
                replyCount++;
            } catch (err) {
                console.warn("[butler] Reply suggestion failed:", err);
            }
        }

        important.push({
            id: tweet.id,
            text: tweet.text,
            authorId: tweet.author_id ?? "",
            authorUsername: author?.username,
            authorVerified: isVerified,
            createdAt: tweet.created_at,
            engagement,
            importanceScore: score,
            matchedMemories: memories,
            suggestedReply,
        });
    }

    return important;
}

/**
 * Fetch recent DMs for the authenticated X user.
 *
 * Requires the X Developer App to have "Direct Messages" read permission.
 * If the app lacks this permission, returns [] with a console warning rather
 * than throwing — callers can check for an empty result.
 *
 * Uses GET /2/dm_events (OAuth 1.0a + dm.read app permission).
 *
 * @param xcUserId  Pinecone namespace.
 * @param limit     Max DM events to fetch (1–50, default 10).
 * @param since     ISO-8601 timestamp for start_time boundary.
 * @param cheapMode Skip reply suggestions.
 */
export async function fetchDMs(
    xcUserId: string,
    limit = 10,
    since?: string,
    cheapMode = false
): Promise<ButlerDM[]> {
    const client = getClient();
    const myId = await getMyXUserId();

    const params: Record<string, unknown> = {
        max_results: Math.min(Math.max(limit, 1), 50),
        "dm_event.fields": ["created_at", "sender_id", "dm_conversation_id", "text"],
        event_types: "MessageCreate",
        expansions: ["sender_id"],
        "user.fields": ["username", "verified"],
    };

    if (since) {
        params.start_time = new Date(since).toISOString();
    }

    let events: LocalDMEvent[];
    let usersMap: Map<string, UserV2>;

    try {
        // GET /2/dm_events — returns a FullDMTimelineV2Paginator
        const dmTimeline = await client.v2.listDmEvents(params as any);
        // .events is the typed getter on DMTimelineV2Paginator
        events = (dmTimeline.events ?? []) as LocalDMEvent[];
        // Raw page data lives under .data; pull includes from there
        const rawData = (dmTimeline as any).data as { includes?: { users?: UserV2[] } } | undefined;
        usersMap = new Map<string, UserV2>(
            (rawData?.includes?.users ?? []).map((u: UserV2) => [u.id, u])
        );
    } catch (err: any) {
        const code = err?.code ?? err?.status ?? 0;
        if (code === 403 || code === 401) {
            console.warn(
                "[butler] DM fetch failed (403/401). " +
                "Enable 'Read + Write + Direct Messages' in your X Developer App settings."
            );
        } else {
            console.warn("[butler] DM fetch error:", err?.message ?? err);
        }
        return [];
    }

    if (!events || events.length === 0) return [];

    const results: ButlerDM[] = [];
    let replyCount = 0;

    for (const event of events) {
        // Skip messages sent by the bot owner themselves
        if (event.sender_id === myId) continue;

        const text = event.text ?? "";
        if (!text.trim()) continue;

        const { score, memories } = await scoreRelevance(xcUserId, text);

        let suggestedReply: string | undefined;
        if (!cheapMode && replyCount < MAX_REPLY_SUGGESTIONS) {
            try {
                suggestedReply = await suggestReply(text, memories, true);
                replyCount++;
            } catch (err) {
                console.warn("[butler] DM reply suggestion failed:", err);
            }
        }

        results.push({
            id: event.id,
            conversationId: (event as any).dm_conversation_id ?? "",
            text,
            senderId: event.sender_id ?? "",
            senderUsername: usersMap.get(event.sender_id ?? "")?.username,
            createdAt: event.created_at,
            importanceScore: score,
            matchedMemories: memories,
            suggestedReply,
        });
    }

    return results;
}

/**
 * Post a reply to a tweet OR send a reply inside a DM conversation,
 * then auto-save the reply to Pinecone memory.
 *
 * @param xcUserId        Pinecone namespace.
 * @param targetId        Tweet ID (for mentions) OR DM event ID (for DMs).
 * @param text            Reply text.
 * @param isDM            Set true to send a DM reply.
 * @param conversationId  Required when isDM=true — the `dm_conversation_id`.
 */
export async function postButlerReply(
    xcUserId: string,
    targetId: string,
    text: string,
    isDM = false,
    conversationId?: string
): Promise<ButlerReplyResult> {
    const client = getClient();

    try {
        let resultId: string;

        if (isDM) {
            if (!conversationId) {
                return { success: false, error: "conversationId is required for DM replies." };
            }
            // POST /2/dm_conversations/:id/messages
            const result = await client.v2.sendDmInConversation(
                conversationId,
                { text }
            );
            resultId = result.dm_event_id;
        } else {
            // POST /2/tweets with reply context
            const { data } = await client.v2.tweet({
                text,
                reply: { in_reply_to_tweet_id: targetId },
            });
            resultId = data.id;
        }

        // Persist reply to long-term memory
        const memoryText =
            `${isDM ? "DM reply" : "Mention reply"} to ${targetId}: "${text}"`;
        const memoryId = await upsertMemory(xcUserId, memoryText, {
            source: isDM ? "butler_dm_reply" : "butler_mention_reply",
            targetId,
            resultId,
            timestamp: new Date().toISOString(),
        });

        console.log(
            `[butler] Reply sent → ${isDM ? "DM" : "tweet"} resultId=${resultId} memoryId=${memoryId}`
        );
        return { success: true, resultId, memoryId };
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        console.error("[butler] Reply failed:", msg);
        return { success: false, error: msg };
    }
}

/**
 * Background butler check: fetch recent mentions in cheap mode and return a
 * human-readable Telegram summary if anything important is found.
 * Returns null if nothing notable was found.
 *
 * Designed to be called every 15 minutes for recently-active users only.
 *
 * @param xcUserId  Pinecone namespace / Telegram user ID.
 * @param sinceMs   How far back to look in milliseconds (default: 16 minutes).
 */
export async function runButlerCheck(
    xcUserId: string,
    sinceMs = 16 * 60 * 1000
): Promise<string | null> {
    const sinceISO = new Date(Date.now() - sinceMs).toISOString();

    // Run mentions and DMs in parallel — both are independent
    const [mentions, dms] = await Promise.allSettled([
        fetchMentions(xcUserId, 20, sinceISO, /* cheapMode */ true),
        fetchDMs(xcUserId, 10, sinceISO, /* cheapMode */ true),
    ]);

    const importantMentions = mentions.status === "fulfilled" ? mentions.value : [];
    const importantDMs = dms.status === "fulfilled" ? dms.value : [];

    if (importantMentions.length === 0 && importantDMs.length === 0) return null;

    const lines: string[] = ["🐦 *X Butler check-in*\n"];

    if (importantMentions.length > 0) {
        lines.push(`*${importantMentions.length} important mention(s):*`);
        for (const m of importantMentions.slice(0, 5)) {
            const author = m.authorUsername ? `@${m.authorUsername}` : m.authorId;
            const badge = m.authorVerified ? " ✓" : "";
            const eng = m.engagement > 0 ? ` (👍${m.engagement})` : "";
            lines.push(`• ${author}${badge}${eng}: "${m.text.slice(0, 120)}..."`);
            lines.push(`  Tweet ID: \`${m.id}\``);
        }
    }

    if (importantDMs.length > 0) {
        lines.push(`\n*${importantDMs.length} new DM(s):*`);
        for (const dm of importantDMs.slice(0, 5)) {
            const sender = dm.senderUsername ? `@${dm.senderUsername}` : dm.senderId;
            lines.push(`• ${sender}: "${dm.text.slice(0, 120)}..."`);
            lines.push(`  Conv ID: \`${dm.conversationId}\``);
        }
    }

    lines.push("\n_Reply via /butler\\_reply or the /drafts push endpoint._");
    return lines.join("\n");
}

/**
 * Start the Butler background watcher.
 *
 * Runs every 15 minutes.  For each recently-active Telegram user (active in
 * the last 30 minutes), performs one cheap X mentions + DM check and
 * sends a Telegram notification if anything important is found.
 *
 * Design goals:
 *  - Zero polling when users are idle (respects REST API rate limits).
 *  - No Gemini calls in background mode (cheapMode=true in runButlerCheck).
 *  - Uses node-cron scheduler already present in the project.
 *
 * @param sendMessage  Function to push a Telegram message to a specific chatId.
 *                     Injected from index.ts the same way as heartbeat.
 * @param chatIdForUser Optional map of userId→chatId. If not supplied, falls
 *                     back to parsing userId as a numeric chatId directly (works
 *                     when the Telegram user ID IS the chat ID, which is true for
 *                     private chats — the typical Xclaw use-case).
 */
export function startButlerWatcher(
    sendMessage: (chatId: number, text: string) => Promise<void>,
    chatIdForUser?: Map<string, number>
): void {
    // Every 15 minutes
    const SCHEDULE = "*/15 * * * *";
    // Consider users active if they messaged in the last 30 minutes
    const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

    cron.schedule(SCHEDULE, async () => {
        const activeUsers = getRecentlyActiveUsers(ACTIVE_WINDOW_MS);
        if (activeUsers.length === 0) return;

        console.log(`[butler-watch] Checking X for ${activeUsers.length} active user(s)`);

        for (const userId of activeUsers) {
            try {
                const summary = await runButlerCheck(userId);
                if (!summary) continue; // nothing important

                // Resolve chatId
                const chatId = chatIdForUser?.get(userId) ?? parseInt(userId, 10);
                if (isNaN(chatId)) {
                    console.warn(`[butler-watch] Cannot resolve chatId for userId=${userId}`);
                    continue;
                }

                await sendMessage(chatId, summary);
                console.log(`[butler-watch] Alert sent → userId=${userId}`);
            } catch (err) {
                console.error(`[butler-watch] Error for userId=${userId}:`, err);
            }
        }
    });

    console.log(`[butler-watch] Background watcher active — cron: "${SCHEDULE}"`);
}
