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
import { getUserXClient } from "../../db/getUserClient";

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

// ── Known-senders cache ───────────────────────────────────────────────────────
// Populated from every successful DM fetch. Lets findDMsFromPerson resolve
// partial names like "sage" → "@sageisthename1" without any API call.
// Keys: full lowercase username AND stripped alphanumeric fragment.
// e.g. "sageisthename1" and "sageisthename1" (same), but also stored under
// any distinct fragment that resolves to it.
const knownSendersCache = new Map<string, { id: string; username: string }>();
/** Secondary index keyed by numeric X sender_id — used by webhook handler. */
const knownSendersByIdCache = new Map<string, { id: string; username: string }>();

function populateKnownSendersCache(dms: Array<{ senderId: string; senderUsername?: string }>): void {
    for (const dm of dms) {
        if (!dm.senderUsername) continue;
        const entry = { id: dm.senderId, username: dm.senderUsername };
        const lower = dm.senderUsername.toLowerCase();
        knownSendersCache.set(lower, entry);
        const frag = lower.replace(/[^a-z0-9]/g, "");
        if (frag && frag !== lower) knownSendersCache.set(frag, entry);
        // Also index by numeric ID for O(1) webhook lookups
        knownSendersByIdCache.set(dm.senderId, entry);
    }
}

/** Look up a known sender by their numeric X user ID (populated from DM fetches). */
export function lookupKnownSender(senderId: string): { id: string; username: string } | undefined {
    return knownSendersByIdCache.get(senderId);
}

/**
 * Resolve an X user ID to a username via the API, with cache population.
 * Falls back to returning the raw ID string if the lookup fails.
 *
 * @param senderId   Numeric X user ID to look up.
 * @param telegramId Telegram user ID used to pick the right X client (optional — falls back to env creds).
 */
export async function resolveXUserId(senderId: string, telegramId?: string | number): Promise<string> {
    const cached = knownSendersByIdCache.get(senderId);
    if (cached) return cached.username;
    try {
        const clientId = telegramId ?? "0";
        const client = await getUserXClient(clientId);
        const { data } = await client.v2.user(senderId, { "user.fields": ["username"] });
        if (data?.username) {
            populateKnownSendersCache([{ senderId, senderUsername: data.username }]);
            return data.username;
        }
    } catch (err) {
        console.warn(`[butler] Could not resolve X user ID ${senderId}:`, err);
    }
    return senderId; // fallback: return the raw ID
}
/** Sum of likes + retweets + replies that makes a mention worth alerting even
 *  without memory relevance (someone is engaging with you seriously). */
const ENGAGEMENT_ALERT_THRESHOLD = 10;
/** Maximum suggested replies generated per call — keeps Gemini costs low. */
const MAX_REPLY_SUGGESTIONS = 3;

// ── Per-user X user ID cache ──────────────────────────────────────────────────
// Keyed by Telegram user ID string to avoid re-fetching me() on every call.
const _myXUserIdCache = new Map<string, string>();

/**
 * Returns the X user ID for the given Telegram user (cached per user).
 * This replaces the old singleton getMyXUserId().
 */
export async function getMyXUserId(xcUserId: string): Promise<string> {
    const cached = _myXUserIdCache.get(xcUserId);
    if (cached) return cached;
    const client = await getUserXClient(xcUserId);
    const { data } = await client.v2.me({ "user.fields": ["id", "username"] });
    _myXUserIdCache.set(xcUserId, data.id);
    console.log(`[butler] @${data.username} (${data.id}) ← telegramId=${xcUserId}`);
    return data.id;
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
    const client = await getUserXClient(xcUserId);
    const xUserId = await getMyXUserId(xcUserId);

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

    // ── Persist each surfaced mention to Pinecone (fire-and-forget, idempotent) ─
    // Stable ID = xcUserId-mention-tweetId, so re-fetching the same mention
    // never creates a duplicate vector. Stored tweet text is the raw content
    // so semantic search ("that mention about the collab") works correctly.
    Promise.allSettled(
        important.map((m) =>
            upsertMemory(
                xcUserId,
                m.text,
                {
                    source: "butler_mention",
                    tweetId: m.id,
                    authorId: m.authorId,
                    authorUsername: m.authorUsername ?? "",
                    createdAt: m.createdAt ?? "",
                },
                `${xcUserId}-mention-${m.id}` // stable — safe to re-upsert
            )
        )
    ).catch((e) => console.warn("[butler] mention Pinecone persist error:", e));

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
    cheapMode = false,
    rawMode = false   // when true: skip Pinecone scoring entirely — used by searchDMs
): Promise<ButlerDM[]> {
    const client = await getUserXClient(xcUserId);
    const myId = await getMyXUserId(xcUserId);

    // X API supports max_results 1–100 for GET /2/dm_events
    const perPage = Math.min(Math.max(limit, 1), 100);
    const params: Record<string, unknown> = {
        max_results: perPage,
        "dm_event.fields": ["created_at", "sender_id", "dm_conversation_id", "text"],
        event_types: "MessageCreate",
        expansions: ["sender_id"],
        "user.fields": ["username", "verified"],
    };

    if (since) {
        params.start_time = new Date(since).toISOString();
    }

    let events: LocalDMEvent[] = [];
    let usersMap: Map<string, UserV2> = new Map();

    try {
        // GET /2/dm_events — returns a FullDMTimelineV2Paginator
        const dmTimeline = await client.v2.listDmEvents(params as any);
        // .events is the typed getter on DMTimelineV2Paginator
        const firstPageEvents = (dmTimeline.events ?? []) as LocalDMEvent[];
        events.push(...firstPageEvents);

        // Step 1: build usersMap from the expansion (raw .data.includes.users is the
        // correct accessor for FullDMTimelineV2Paginator in twitter-api-v2 v1.29.0;
        // the .includes.user() helper does NOT exist in this version)
        const rawData = (dmTimeline as any).data as { includes?: { users?: UserV2[]; }; meta?: { next_token?: string } } | undefined;
        const includedUsers: UserV2[] = rawData?.includes?.users ?? [];
        for (const u of includedUsers) usersMap.set(u.id, u);

        // Paginate for rawMode (search): keep fetching until we have `limit` raw events
        // or exhaust all pages. Limit to 5 pages max to avoid rate-limit abuse.
        if (rawMode && limit > perPage) {
            let nextToken: string | undefined = rawData?.meta?.next_token
                ?? (dmTimeline as any).meta?.next_token;
            let pagesLoaded = 1;
            while (events.length < limit && nextToken && pagesLoaded < 5) {
                console.log(`[butler:dm] Paginating DM events (page ${pagesLoaded + 1}), collected ${events.length} so far`);
                const nextPage = await client.v2.listDmEvents({
                    ...params,
                    pagination_token: nextToken,
                } as any);
                const nextEvents = (nextPage.events ?? []) as LocalDMEvent[];
                events.push(...nextEvents);
                const nextRaw = (nextPage as any).data as { includes?: { users?: UserV2[] }; meta?: { next_token?: string } } | undefined;
                for (const u of nextRaw?.includes?.users ?? []) usersMap.set(u.id, u);
                nextToken = nextRaw?.meta?.next_token ?? (nextPage as any).meta?.next_token;
                pagesLoaded++;
                if (nextEvents.length === 0) break;
            }
            console.log(`[butler:dm] Pagination done — ${events.length} total raw events across ${pagesLoaded} page(s)`);
        }

        const unresolvedIds: string[] = [];
        for (const ev of events) {
            if (!ev.sender_id) continue;
            if (!usersMap.has(ev.sender_id)) {
                unresolvedIds.push(ev.sender_id);
            }
        }

        // Step 2: fallback batch lookup for any sender_id the expansion didn't resolve.
        // Deduplicate first, then batch — GET /2/users?ids=... is v2 and free-tier safe.
        const uniqueUnresolvedIds = [...new Set(unresolvedIds)];
        if (uniqueUnresolvedIds.length > 0) {
            console.log(`[butler:dm] Expansion missed ${uniqueUnresolvedIds.length} unique sender(s): [${uniqueUnresolvedIds.join(",")}] — running batch v2 user lookup`);
            try {
                const batchResult = await client.v2.users(uniqueUnresolvedIds, {
                    "user.fields": ["username", "verified"],
                } as any);
                const resolved = batchResult.data ?? [];
                console.log(`[butler:dm] Batch lookup resolved ${resolved.length}/${uniqueUnresolvedIds.length} sender(s):`, resolved.map((u: UserV2) => `@${u.username}(${u.id})`).join(", ") || "none");
                for (const u of resolved) {
                    usersMap.set(u.id, u);
                }
            } catch (batchErr) {
                console.warn("[butler:dm] Batch user lookup failed:", (batchErr as any)?.message ?? batchErr);
            }
        }
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

        // rawMode: skip Pinecone entirely — return every DM so search can see all of them
        let score = 0;
        let memories: string[] = [];
        if (!rawMode) {
            const relevance = await scoreRelevance(xcUserId, text);
            score = relevance.score;
            memories = relevance.memories;
        }

        let suggestedReply: string | undefined;
        if (!cheapMode && !rawMode && replyCount < MAX_REPLY_SUGGESTIONS) {
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

    // Populate known-senders cache so future partial-name lookups (e.g. "sage") can
    // resolve to the real handle without any additional API calls.
    populateKnownSendersCache(results);

    return results;
}

/**
 * Returns true if the query is asking for DMs FROM/BY a specific person
 * (as opposed to a topic/content search).
 * e.g. "bring me the latest dm from sage" → true
 *      "find the dm about advertising"     → false
 */
function isPersonQuery(query: string): boolean {
    return /(?:^|\s)(?:from|by)\s*@?\w/i.test(query.trim());
}

/**
 * Extract the core name/handle target from a natural-language DM query.
 * e.g. "bring me the latest dm from sage" → "sage"
 *      "find dm by @sageisthename1"        → "sageisthename1"
 *      "dm about advertising"              → "advertising"
 */
function extractDMTarget(query: string): string {
    const lower = query.toLowerCase().trim();

    // Primary: catch "from sage", "by sage", "from @sage", etc.
    const match = lower.match(/(?:from|by)\s*@?(\w+)/i);
    if (match?.[1]) return match[1];

    // Fallback: strip common filler prefixes, take first meaningful word
    return lower
        .replace(/^(bring me|can you|find|show|pull|give me|open|the latest|recent).*(dm|message|dms? from|dms? by)/i, "")
        .trim()
        .replace(/^@/, "")
        .split(/\s+/)[0] ?? "";
}

/**
 * For "from <person>" queries: resolve the person via X API user lookup
 * (exact handle first, then v1 search fallback) then fetch only THEIR conversation.
 * senderUsername is guaranteed correct — no expansion needed.
 */
async function findDMsFromPerson(xcUserId: string, query: string): Promise<ButlerDM[]> {
    const targetName = extractDMTarget(query);
    console.log(`[DM Search DEBUG] Raw query: "${query}" → extracted targetName: "${targetName}"`);

    if (!targetName || targetName.length < 2) {
        console.log(`[DM Search DEBUG] Target name too short, skipping`);
        return [];
    }

    const client = await getUserXClient(xcUserId);

    // Step 0: check known-senders cache — resolves partial names like "sage" → "@sageisthename1"
    // populated from all previous fetchDMs calls this session.
    const cacheTarget = targetName.toLowerCase();
    const cacheFrag = cacheTarget.replace(/[^a-z0-9]/g, "");
    const cachedUser = knownSendersCache.get(cacheTarget) ??
        [...knownSendersCache.entries()].find(([k]) => k.includes(cacheFrag) || cacheFrag.includes(k))?.[1];

    // Step 1: exact handle — only trust this match if the conversation actually has DMs.
    // e.g. "sage" matches real account @sage (id:6014) which never DMed us — skip it.
    let exactCandidates: Array<{ id: string; username: string }> = [];
    if (cachedUser) {
        console.log(`[DM Search DEBUG] Cache hit: "${targetName}" → @${cachedUser.username} (${cachedUser.id})`);
        exactCandidates = [cachedUser];
    } else {
        try {
            console.log(`[DM Search DEBUG] Trying exact userByUsername("${targetName}")`);
            const exact = await client.v2.userByUsername(targetName);
            if (exact.data) {
                exactCandidates = [exact.data];
                console.log(`[DM Search DEBUG] Exact handle exists: @${exact.data.username} (id: ${exact.data.id}) — will verify has DMs`);
            }
        } catch (e: any) {
            console.log(`[DM Search DEBUG] userByUsername failed (expected for "${targetName}"): ${e?.message ?? e}`);
        }
    }

    // Step 2: v1.searchUsers is blocked on X Free tier (403) — skip it.
    // Resolution happens via the second-chance individual v2 user lookup in searchDMs.
    const searchCandidates: Array<{ id: string; username: string }> = [];
    console.log(`[DM Search DEBUG] v1.searchUsers unavailable on Free tier — relying on broad search + ID resolution fallback`);

    // Step 3: try all candidates (exact first, then search results) — pick the first with actual DMs
    const myId = await getMyXUserId(xcUserId);
    const allCandidates = [...exactCandidates, ...searchCandidates.filter(c => !exactCandidates.some(e => e.id === c.id))];
    console.log(`[DM Search DEBUG] ${allCandidates.length} total candidates to check for DMs`);

    for (const candidate of allCandidates) {
        try {
            console.log(`[DM Search DEBUG] Checking DMs with @${candidate.username} (${candidate.id})`);
            const timeline = await client.v2.listDmEventsWithParticipant(candidate.id, {
                max_results: 20,
                "dm_event.fields": ["created_at", "sender_id", "dm_conversation_id", "text"],
                expansions: ["sender_id"],
                "user.fields": ["username", "verified"],
            } as any);
            const events = ((timeline as any).events ?? []) as LocalDMEvent[];
            const inbound = events.filter(ev => ev.sender_id !== myId && ev.text?.trim());
            console.log(`[DM Search DEBUG] @${candidate.username}: ${events.length} events, ${inbound.length} inbound`);

            if (inbound.length === 0) {
                console.log(`[DM Search DEBUG] @${candidate.username} has 0 inbound DMs — trying next candidate`);
                continue;  // ← key fix: wrong user, try next instead of giving up
            }

            const matched: ButlerDM[] = [];
            let replyCount = 0;
            for (const ev of inbound) {
                let suggestedReply: string | undefined;
                if (replyCount < MAX_REPLY_SUGGESTIONS) {
                    try { suggestedReply = await suggestReply(ev.text ?? "", [], true); replyCount++; }
                    catch { /* non-fatal */ }
                }
                matched.push({
                    id: ev.id,
                    conversationId: (ev as any).dm_conversation_id ?? "",
                    text: ev.text ?? "",
                    senderId: ev.sender_id ?? "",
                    senderUsername: candidate.username,   // guaranteed correct
                    createdAt: ev.created_at,
                    importanceScore: 1,
                    matchedMemories: [],
                    suggestedReply,
                });
            }
            // Cache this candidate so future partial queries resolve instantly
            populateKnownSendersCache(matched);
            console.log(`[DM Search DEBUG] ✅ Returning ${matched.length} DMs from @${candidate.username}`);
            return matched;
        } catch (e: any) {
            console.log(`[DM Search DEBUG] listDmEventsWithParticipant failed for @${candidate.username}: ${e?.message ?? e}`);
        }
    }

    // All candidates exhausted with no DMs found
    console.log(`[DM Search DEBUG] ❌ No candidate had inbound DMs for "${targetName}"`);
    return [];
}

/**
 * Search through recent DMs for ones matching a natural-language query.
 *
 * Flow:
 *   1. Try findDMsFromPerson — resolves user by handle or search, fetches their conversation.
 *      If found, return immediately. No Pinecone. No Gemini.
 *   2. Broad fetch (50 DMs, rawMode) with username pre-filter (now reliable with batch lookup).
 *   3. Gemini semantic search for topic/content queries with no clear sender.
 *
 * @param xcUserId  Pinecone namespace / Telegram user ID.
 * @param query     Natural language search, e.g. "from sage" or "about the advertising issue".
 */
export async function searchDMs(
    xcUserId: string,
    query: string
): Promise<ButlerDM[]> {
    console.log(`[DM Search DEBUG] === START searchDMs query: "${query}" ===`);

    // ── Step 0: Person-specific path (most accurate) ─────────────────────────
    const personMatches = await findDMsFromPerson(xcUserId, query);
    if (personMatches.length > 0) {
        console.log(`[DM Search DEBUG] SUCCESS — returning ${personMatches.length} DMs from person`);
        return personMatches;
    }

    console.log(`[DM Search DEBUG] findDMsFromPerson returned [] — falling back to broad rawMode search`);

    // ── Broad search: fetch recent DMs across multiple pages (rawMode — no Pinecone scoring) ──
    // limit=200 causes fetchDMs to paginate up to 5 pages of 100 raw events each.
    const allDMs = await fetchDMs(xcUserId, 200, undefined, /* cheapMode */ true, /* rawMode */ true);
    if (allDMs.length === 0) return [];

    // ── Second-chance username resolution ────────────────────────────────────
    // fetchDMs already tried a batch lookup; this catches any still-unresolved senders
    // by calling GET /2/users/:id individually (v2 free-tier safe, max 10 calls).
    const client = await getUserXClient(xcUserId);
    const stillMissing = [...new Map(
        allDMs.filter(dm => !dm.senderUsername).map(dm => [dm.senderId, dm])
    ).values()].slice(0, 10);

    if (stillMissing.length > 0) {
        console.log(`[DM Search DEBUG] ${stillMissing.length} sender(s) still have no username — resolving individually`);
        for (const dm of stillMissing) {
            try {
                const res = await client.v2.user(dm.senderId, { "user.fields": ["username"] } as any);
                if (res.data?.username) {
                    console.log(`[DM Search DEBUG] Resolved senderId ${dm.senderId} → @${res.data.username}`);
                    // Patch all DMs that share this senderId
                    for (const d of allDMs) {
                        if (d.senderId === dm.senderId) {
                            (d as any).senderUsername = res.data.username;
                        }
                    }
                }
            } catch (e: any) {
                console.log(`[DM Search DEBUG] Could not resolve ${dm.senderId}: ${e?.message ?? e}`);
            }
        }
    }

    const cleanQuery = extractDMTarget(query);
    console.log(`[DM Search DEBUG] Broad search — extracted target: "${cleanQuery}" across ${allDMs.length} DMs — usernames resolved: ${allDMs.filter(d => d.senderUsername).length}/${allDMs.length}`);
    console.log(`[DM Search DEBUG] All senderUsernames:`, allDMs.map(d => d.senderUsername ?? `<null:${d.senderId}>`).join(", "));

    // ── Step 1: Direct pre-filter ────────────────────────────────────────────
    // For person queries ("from sage") only match on senderUsername — NEVER on
    // text content, because the word "sage" (or any name) can appear in unrelated
    // DM bodies and cause false positives (e.g. AdsSupport mentioning "sage advice").
    // For topic/content queries ("about advertising") match on text as well.
    const personQuery = isPersonQuery(query);
    if (cleanQuery.length >= 2) {
        const directMatches = allDMs
            .map((dm, i) => ({
                i,
                match: personQuery
                    ? (dm.senderUsername ?? "").toLowerCase().includes(cleanQuery)
                    : (dm.senderUsername ?? "").toLowerCase().includes(cleanQuery) ||
                      dm.text.toLowerCase().includes(cleanQuery),
            }))
            .filter(x => x.match)
            .map(x => x.i);

        console.log(`[DM Search DEBUG] Direct filter (${personQuery ? "username-only" : "username+text"}): ${directMatches.length} match(es) for "${cleanQuery}"`);

        if (directMatches.length > 0) {
            // Found via direct match — no Gemini call needed
            const matched: ButlerDM[] = [];
            let replyCount = 0;
            for (const idx of directMatches) {
                const dm = allDMs[idx];
                let suggestedReply = dm.suggestedReply;
                if (!suggestedReply && replyCount < MAX_REPLY_SUGGESTIONS) {
                    try {
                        suggestedReply = await suggestReply(dm.text, dm.matchedMemories, true);
                        replyCount++;
                    } catch { /* non-fatal */ }
                }
                matched.push({ ...dm, suggestedReply });
            }
            return matched;
        }
    }

    // ── Step 2: Gemini semantic search (fallback for topic/content queries only) ──
    // SKIP Gemini for person-name queries ("from sage", "by alex", etc.).
    // When a person is targeted but not found in the fetched DMs, returning []
    // is far better than letting Gemini pick a semantically unrelated sender.
    if (personQuery) {
        console.log(`[DM Search DEBUG] Person query — no username match found, returning not-found for "${cleanQuery}"`);
        return [];
    }

    // Build a compact summary — includes both username AND senderId so Gemini
    // can still reason about numeric IDs if the username expansion failed.
    const summaries = allDMs.map((dm, i) =>
        `[${i}] username:${dm.senderUsername ?? "unknown"} senderId:${dm.senderId} text:"${dm.text.slice(0, 150).replace(/"/g, "'")}"`
    ).join("\n");

    const ai = new GoogleGenerativeAI(config.GEMINI_API_KEY);
    const model = ai.getGenerativeModel({ model: config.GEMINI_MODEL });

    const result = await model.generateContent(
        `You are a DM search engine. The user wants to find DMs matching this description:
"${query.replace(/"/g, "'")}"

Here are the available DMs (indexed from 0):
${summaries}

Return a JSON array of index numbers that match the user's description.
Match on username OR message content. Be generous with partial matches.
If none match, return [].
Return ONLY the JSON array, no explanation.`
    );

    let matchedIndices: number[] = [];
    try {
        const raw = result.response.text().trim().replace(/^```json\n?|```$/g, "").trim();
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            matchedIndices = parsed.filter((n): n is number =>
                typeof n === "number" && n >= 0 && n < allDMs.length
            );
        }
    } catch {
        // Gemini output unparseable — nothing to return, direct filter already ran above
        matchedIndices = [];
    }

    if (matchedIndices.length === 0) return [];

    // Generate reply suggestions for matched DMs (up to MAX_REPLY_SUGGESTIONS)
    const matched: ButlerDM[] = [];
    let replyCount = 0;
    for (const idx of matchedIndices) {
        const dm = allDMs[idx];
        let suggestedReply = dm.suggestedReply;
        if (!suggestedReply && replyCount < MAX_REPLY_SUGGESTIONS) {
            try {
                suggestedReply = await suggestReply(dm.text, dm.matchedMemories, true);
                replyCount++;
            } catch { /* non-fatal */ }
        }
        matched.push({ ...dm, suggestedReply });
    }

    return matched;
}

/**
 * Search past mentions by semantic context — e.g. "that mention from bob",
 * "the one about the collab", "find the mention from @guy".
 *
 * Queries Pinecone for `source: "butler_mention"` vectors matching the query.
 * Returns up to `limit` matches as PendingMention-compatible objects with
 * freshly-generated reply suggestions.
 *
 * Mentions are persisted to Pinecone inside `fetchMentions`, so any mention
 * the user has ever been shown is searchable here — even across sessions.
 */
export async function searchMentionsByContext(
    xcUserId: string,
    query: string,
    limit = 5
): Promise<Array<{ id: string; authorId: string; authorUsername: string; text: string; suggestedReply?: string }>> {
    // Cast a wide net (topK=20) then filter to mention records only
    const results = await queryMemory(xcUserId, query, 20);
    const mentionResults = results
        .filter((r) => r.metadata?.source === "butler_mention")
        .slice(0, limit);

    if (mentionResults.length === 0) return [];

    const out: Array<{ id: string; authorId: string; authorUsername: string; text: string; suggestedReply?: string }> = [];
    for (const r of mentionResults) {
        const tweetId = r.metadata?.tweetId ?? r.id;
        const authorId = r.metadata?.authorId ?? "";
        const authorUsername = r.metadata?.authorUsername ?? "";
        const tweetText = r.text; // raw tweet text stored at upsert time

        let suggestedReply: string | undefined;
        try {
            suggestedReply = await suggestReply(tweetText, [], false);
        } catch { /* non-fatal */ }

        out.push({ id: tweetId, authorId, authorUsername, text: tweetText, suggestedReply });
    }
    return out;
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
    const client = await getUserXClient(xcUserId);

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
