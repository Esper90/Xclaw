# Xclaw Autonomous Tools Implementation Plan

## Order of Execution
1) Daily Butler Brief (highest priority)
2) Timeline Sentinel + Smart Mention Radar
3) Proactive Vibe Check
4) Content Repurposer
5) Price & Deal Hunter
6) GitHub Co-Pilot Watcher
7) Thread Archaeologist

## Foundations (apply before/while building features)
- BYOK gate for all X actions: use the existing 4-key OAuth1 creds from `/setup` (stored in Supabase, resolved via `getUserXClient`). No bearer key required.
- Supabase remains system of record for profile/limits (new columns already added); Pinecone is for vectors/summaries only.
- Use the profile helper (already added) to read/write timezone, vip_list, wishlist, watched_repos, brief_last_sent_at, vibe_check_freq_days, last_tweet_ids, tavily/x call counters + resets, brief_cache, prefs.
- Rate-limit middleware: Tavily ≤2/day/user; X ≤3/hour/user. Store counters/resets in Supabase; enforce before tool execute() using the budget helper stub (claws/sense/apiBudget.ts) as a starting point.
- Caching: Pinecone TTL (≈1h) for expensive fetches (X data, Tavily results, thread summaries); avoid duplicate API calls.
- Cron location: follow existing node-cron pattern (e.g., heartbeat, xButler). Add new schedulers in a dedicated folder (e.g., src/claws/watchers) and register them from index.ts; skip X-related crons when no creds.
- Output: Telegram-friendly markdown with inline buttons (approve/post/ignore/schedule). Persist important summaries/decisions to Pinecone memories.
- Logging + error handling: structured console logs; no unhandled rejections; loops never crash on single failure.
- Env toggles: cron intervals, cache TTLs, and rate-limit ceilings configurable for dev.

## Feature Specs
### 1) Daily Butler Brief
- Trigger: 07:30 in user timezone (env override); skip if sent <24h (brief_last_sent_at).
- Content: 3–5 Tavily headlines; X mentions summary if key else note to add key; calendar conflicts; weather; 1–2 personalized reminders; quick vibe check.
- Output: sectioned Telegram message + buttons “Read full”, “Dismiss”, “Schedule follow-up”.
- Cache: store last brief content/metadata (brief_cache) and timestamp; persist summary to Pinecone.

### 2) Timeline Sentinel + Smart Mention Radar
- Requires X key; otherwise planner responds with requirement notice.
- Cron: every 30m (env override). VIP list per user (vip_list). Cache last_tweet_ids per handle.
- Fetch only new VIP tweets + mentions; respect X call budget. Produce digest “5 tweets that matter” + auto-draft replies (Approve button). Persist digest + memories; update last_tweet_ids.

### 3) Proactive Vibe Check
- Cadence: every 3 days (vibe_check_freq_days). Analyze Telegram recents + X activity (if key) + calendar + weather.
- Output: “You’ve been grinding hard…” with Yes/No + quick options; if yes, create reminder/calendar slot. Note when X skipped.

### 4) Content Repurposer
- Triggers: watcher on new X post (if key) or manual “repurpose this”.
- Take latest X post → generate LinkedIn, Telegram carousel, newsletter blurb, thread version. Save drafts with “Post to LinkedIn / Telegram” buttons. If no key, disable auto-detect; allow manual text-only repurpose.

### 5) Price & Deal Hunter
- Wishlist in prefs. Daily cron + on-demand. Tavily + Amazon/eBay affiliate (free). Alert on ≥10% drop/new deal with “Buy now” button. No X dependency.

### 6) GitHub Co-Pilot Watcher
- Watched repos in prefs. Daily stats via GitHub API (optional PAT BYOK). Summary: stars/PRs/issues + top contributors; auto-draft X post if key, otherwise skip draft. Cache last seen stats.

### 7) Thread Archaeologist
- Trigger: forwarded tweet link or “explain this thread”. Requires X key; otherwise respond with requirement message.
- Fetch full thread via X API; summarize with Gemini + key opinions; output threaded summary + “Reply with this” button. Cache summary (TTL ≈1h).

## Planner Prompt Update
- Add all 7 tools with gating notes: only suggest X tools when user has provided key. Describe when to use each (brief, sentinel, vibe check, repurposer, deals, GH watcher, thread archaeologist).
- Snippet lives at [docs/planner_prompt_snippet.md](docs/planner_prompt_snippet.md).

## Tests
- 1–2 unit/integration tests per major feature: key gating, rate-limit enforcement, caching behavior, button payloads, cron skip logic without X key.

## Deliverables
- New autonomous tools under a dedicated folder consistent with current tooling (e.g., src/claws/autonomous/ or src/claws/wire/tools/autonomous/) with cron wiring registered from index.ts.
- Updated planner prompt snippet reflecting the 7 tools and gating.
- Console logs like “Daily Brief generated for user X (X features skipped: no key)”.
- Final summary: list new files, updated planner snippet, Telegram test commands.
