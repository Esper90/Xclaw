# DM Search Debug — Help Request for Senior X Dev

**Last updated:** February 22, 2026

---

## What We Are Building

An AI Telegram bot (Xclaw) that acts as a personal X (Twitter) assistant.
One feature: the user can ask the bot in natural language — by text or voice — to find specific DMs.

Example requests:
- "bring me the latest dm from sage"
- "can you bring up the dms from sage is the name"
- "find the dm from @sageisthename1"
- "find the dm about the advertising issue"

When a specific DM is found, the bot shows it with a suggested reply and the user can say
"reply to A" to send the reply directly — all without leaving Telegram.

---

## The Stack

- **X API:** twitter-api-v2 v1.29.0 (Node.js)
- **Telegram bot:** Grammy framework
- **Endpoint used:** `GET /2/dm_events` via `client.v2.listDmEvents(params)`
- **Auth:** OAuth 1.0a User Context
- **X App permissions:** Read + Write + Direct Messages (confirmed active)
- **Access Token:** Regenerated after adding DM permissions (February 21, 2026)
- **Deployed on:** Railway

---

## Current State (as of Feb 22, 2026)

We have **two open bugs** that still need fixing. Both are described in full below.

---

## Bug 1: Telegram 409 Conflict Loop on Railway Redeploy ❌

### Symptom

Every time a new container is deployed on Railway, the startup fails with:

```
💥 Fatal startup error: GrammyError: Call to 'getUpdates' failed!
(409: Conflict: terminated by other getUpdates request; make sure that only
one bot instance is running)
```

The container then crashes, Railway restarts it, and the 409 hits again — creating a crash loop
that lasts 30–60 seconds before the old container finally releases the Telegram connection.

### What We've Tried

We added a SIGTERM handler to gracefully stop the Grammy bot before the process exits:

```typescript
// src/index.ts
const shutdown = async (signal: string) => {
    console.log(`[bot] ${signal} received — stopping bot gracefully`);
    await bot.stop();
    process.exit(0);
};
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT",  () => shutdown("SIGINT"));
```

**Result:** The SIGTERM handler fires and logs correctly. The old container does say
`npm error signal SIGTERM` and stops. But the new container starts polling before Telegram
releases the session, so it still hits 409. The loop resolves itself after ~30–60s but it's
noisy and causes missed messages during that window.

### What We Need for Bug 1

- Does Grammy have a built-in retry/backoff for 409 on startup?
- Is there a way to tell Grammy to wait and retry `getUpdates` instead of throwing a fatal error?
- Alternatively: is there a Railway-specific pattern (e.g. health check delay, `sleep` before
  `bot.start()`) that prevents this race condition?

---

## Bug 2: "Find me the latest DM from sage" Returns Wrong Results ❌

### Background

User says "find me the latest dm from sage" — they mean `@sageisthename1`.
The bot should find and display that DM. It is not doing so.

### What `GET /2/dm_events` Returns

Request params:
```javascript
{
    max_results: 100,
    "dm_event.fields": ["created_at", "sender_id", "dm_conversation_id", "text"],
    event_types: "MessageCreate",
    expansions: ["sender_id"],
    "user.fields": ["username", "verified"]
}
```

The API returns **39 total raw events across 1 page** — this is the full extent of what the
API provides. There are no more pages (no `next_token`). After filtering out the bot owner's
own outbound messages (`sender_id === myId`), only **15 inbound DMs** remain.

Those 15 DMs are from: `AdsSupport` (×12), `premium` (×2), `aandani_nirali` (×1).

**`@sageisthename1`'s DM is not in those 39 events at all.**

### What We've Tried (Chronological)

#### Attempt 1 — Pinecone relevance gate (original design)
`fetchDMs()` scores every DM against the user's memory. Only DMs scoring ≥ 0.72 are returned.
New contacts like `@sageisthename1` score 0 and are dropped.

**Result:** New contacts never surface. ❌

---

#### Attempt 2 — `rawMode=true` bypass
Added a `rawMode` flag to `fetchDMs()`. Bypasses Pinecone entirely, returns everything.
`searchDMs()` now calls `fetchDMs(xcUserId, 200, ..., rawMode=true)`.

**Result:** Pinecone no longer blocks anything. But `@sageisthename1` is simply not in the
events the API returned. ❌

---

#### Attempt 3 — Batch `GET /2/users?ids=` fallback for unresolved sender_ids
`includes.users` in the DM event expansion doesn't resolve every `sender_id` reliably.
We added a deduped batch `client.v2.users(unresolvedIds)` call after the initial expansion.

**Result:** All 15 inbound sender IDs are now resolved correctly to usernames (15/15).
But `@sageisthename1` still isn't in the 15 DMs — the event wasn't returned by the API. ❌

---

#### Attempt 4 — Individual `GET /2/users/:id` second-pass for any still-unresolved senders
After `fetchDMs`, we run a second pass calling `client.v2.user(senderId)` for any DMs that
still have `senderUsername = undefined` after the batch lookup.

**Result:** Also not needed in practice — all 15 resolve fine via the batch. The fundamental
issue is that `@sageisthename1`'s DM event never comes back from `GET /2/dm_events`. ❌

---

#### Attempt 5 — Paginate `fetchDMs` up to 5 pages of 100 events
When `rawMode=true`, `fetchDMs` now paginates using `next_token` across up to 5 pages.
`searchDMs` requests `limit=200`.

**Result:** API returned 39 events across 1 page — there is no `next_token`, the timeline
is exhausted. No more pages to fetch. Still no `@sageisthename1`. ❌

---

#### Attempt 6 — `findDMsFromPerson`: resolve partial name → user ID → `listDmEventsWithParticipant`
Added a pre-step that:
1. Calls `client.v2.userByUsername(targetName)` for an exact handle match
2. Calls `client.v2.listDmEventsWithParticipant(userId)` to query the specific conversation

**Result:** `userByUsername("sage")` resolves to `@sage (id: 6014)` — a real but completely
unrelated account that has 0 DM events with the user. The real target is `@sageisthename1`
but we only have the fragment "sage" — there is no free-tier API call that lets us search
users by partial name to discover their real handle. ❌

---

#### Attempt 7 — `v1.searchUsers("sage")` to find potential handles
Added `client.v1.searchUsers("sage")` to find accounts whose handle or name contains "sage".

**Result:** `GET /1.1/users/search.json` returns HTTP 403 on the X Free tier. Blocked. ❌

---

#### Attempt 8 — Gemini semantic fallback
When direct matching failed, we let Gemini rank all 15 DMs against the query "from sage".
Gemini semantically matched AdsSupport DMs (advertising context) to "sage" and returned them.

**Result:** Completely wrong DMs shown to the user. Now fixed — Gemini is skipped entirely
for person-name queries (`"from X"`, `"by X"`). ✅

---

### Current Live Logs

This is what Railway logs show when the user says "find me the latest dm from sage":

```
[DM Search DEBUG] === START searchDMs query: "from sage" ===
[DM Search DEBUG] Raw query: "from sage" → extracted targetName: "sage"
[DM Search DEBUG] Trying exact userByUsername("sage")
[DM Search DEBUG] Exact handle exists: @sage (id: 6014) — will verify has DMs
[DM Search DEBUG] v1.searchUsers unavailable on Free tier — relying on broad search + ID resolution fallback
[butler] Authenticated as X user @FaboRoque (2012679673226899456)
[DM Search DEBUG] 1 total candidates to check for DMs
[DM Search DEBUG] Checking DMs with @sage (6014)
[DM Search DEBUG] @sage: 0 events, 0 inbound
[DM Search DEBUG] @sage has 0 inbound DMs — trying next candidate
[DM Search DEBUG] ❌ No candidate had inbound DMs for "sage"
[DM Search DEBUG] findDMsFromPerson returned [] — falling back to broad rawMode search
[butler:dm] Pagination done — 39 total raw events across 1 page(s)
[DM Search DEBUG] Broad search — extracted target: "sage" across 15 DMs — usernames resolved: 15/15
[DM Search DEBUG] All senderUsernames: AdsSupport, premium, premium, AdsSupport, AdsSupport,
AdsSupport, AdsSupport, AdsSupport, AdsSupport, AdsSupport, AdsSupport, AdsSupport, AdsSupport,
AdsSupport, aandani_nirali
```

**Summary:** The bot currently returns a clean "not found" message (Gemini no longer runs for
person queries). This is correct behavior given the data — the DM simply isn't in what the API
returns. The core question is **why**.

---

### The Core Question for the Senior Dev

`GET /2/dm_events` returns **only 39 raw events** and reports no `next_token`.
We know `@sageisthename1` sent a DM recently. That event is not in the 39.

**Specifically:**

1. **Is `GET /2/dm_events` supposed to return the full DM inbox history, or is it rate/time
   windowed?** On the X Free tier, is there a limit on how far back this endpoint goes?

2. **Why would an event from a recent conversation be absent from `GET /2/dm_events`?**
   Could it be a conversation type issue (e.g. the DM was opened via a specific thread,
   or involves a restricted account)?

3. **`GET /2/dm_conversations/:dm_conversation_id/dm_events` — if we had the conversation ID,
   could we fetch that specific thread directly?** The DM events we do get include
   `dm_conversation_id` — could we use those to enumerate all conversations and find the missing one?

4. **Is there a `GET /2/dm_conversations` endpoint** that lists all active conversations
   (with participants) even if their events aren't surfaced by `GET /2/dm_events`? That
   would let us build a conversation list and query each one via `listDmEventsWithParticipant`.

5. **For the partial-name problem ("sage" → "sageisthename1"):** Given that `v1.searchUsers`
   is 403 on Free tier and `v2/users/by/username` requires an exact match, what is the
   recommended approach to resolve a partial display name or first name to a real handle?
   Is there any v2 endpoint that does fuzzy/prefix user search on Free tier?

---

## What We Need for Bug 2

A way to either:

**Option A** — Make `GET /2/dm_events` (or `GET /2/dm_conversations`) return the conversation
with `@sageisthename1` so we can filter by username substring.

**Option B** — Given a partial name like "sage", resolve it to a user ID so we can call
`listDmEventsWithParticipant` directly against the right conversation — without relying on
`v1.searchUsers` (which is 403 on Free tier).

---

## Current Code (Relevant Sections)

**File:** `src/claws/wire/xButler.ts`

### `fetchDMs` — pagination + username resolution

```typescript
export async function fetchDMs(
    xcUserId: string,
    limit = 10,
    since?: string,
    cheapMode = false,
    rawMode = false
): Promise<ButlerDM[]> {
    const perPage = Math.min(Math.max(limit, 1), 100);
    const params: Record<string, unknown> = {
        max_results: perPage,
        "dm_event.fields": ["created_at", "sender_id", "dm_conversation_id", "text"],
        event_types: "MessageCreate",
        expansions: ["sender_id"],
        "user.fields": ["username", "verified"],
    };

    const dmTimeline = await client.v2.listDmEvents(params as any);
    // Paginate when rawMode=true, up to 5 pages
    // Batch-resolves unresolved sender_ids via GET /2/users?ids=...
    // Falls back to individual GET /2/users/:id for any still-missing
}
```

### `findDMsFromPerson` — exact handle → listDmEventsWithParticipant

```typescript
async function findDMsFromPerson(query: string): Promise<ButlerDM[]> {
    const targetName = extractDMTarget(query);  // "sage"

    // Step 1: exact handle lookup — finds @sage (id:6014), not @sageisthename1
    const exactUser = await client.v2.userByUsername(targetName, ...);

    // Step 2: v1.searchUsers — BLOCKED (403 on Free tier), removed

    // Step 3: for each candidate, call listDmEventsWithParticipant
    // @sage (6014) has 0 DMs → skipped, returns []
}
```

### `searchDMs` — orchestrator

```typescript
export async function searchDMs(xcUserId: string, query: string): Promise<ButlerDM[]> {
    // 1. Try findDMsFromPerson — returns [] for "sage" (wrong @sage account, @sageisthename1 not found)
    // 2. Broad rawMode fetch — 39 raw events, 15 inbound, no @sageisthename1
    // 3. Direct substring filter — no match (sageisthename1 not in results)
    // 4. Gemini — SKIPPED for person queries (was returning wrong AdsSupport DMs)
    // → returns [] → caller shows "not found" with hint to try full @handle
}
```

---

## Environment

- twitter-api-v2: v1.29.0
- Grammy: latest
- Node.js: 20+
- TypeScript: 5.7
- Deployed on Railway (single instance)
- X App: OAuth 1.0a, permissions: Read + Write + Direct Messages
- X Plan: Free tier
