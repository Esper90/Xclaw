# /setup Wizard — Supabase Auth Failure — Help Request for Senior Dev

**Last updated:** February 22, 2026  
**Status:** Blocked — `upsertUser()` throws "Invalid API key" from Supabase on every run

---

## What We Are Building

Xclaw is a personal AI Telegram bot that acts as an X (Twitter) assistant.
It is a multi-user SaaS: each user stores their **own** X API keys in a shared Supabase
table (`xclaw_users`). The `/setup` wizard walks the user through entering their 4 X tokens
step-by-step via Telegram messages, validates them against the X API, then saves the record
to Supabase.

---

## The Three-Step `/setup` Flow

```
User runs /setup in Telegram
  │
  ├─ [Step 1–4] Collect 4 X keys via Telegram wizard
  │
  ├─ [Validate] TwitterApi.v1.verifyCredentials() ← ✅ PASSES
  │
  ├─ [Save] upsertUser() → Supabase xclaw_users      ← ❌ FAILS HERE
  │             "Invalid API key"
  │
  └─ [Webhook] registerAndSubscribeWebhook()          ← never reached
```

---

## What Is Failing

### Error message

```
[setup:validate] SUPABASE ERROR: Invalid API key { urlInUse: 'https://nxkpthesrtlwbcwhavqn.supabase.co', keyLen: 221 }
```

This error comes from Supabase's REST API — the `service_role` JWT it receives is invalid/revoked.
It is **not** an X API error. X auth succeeds (`@FaboRoque` confirmed in logs).

### Full Railway log from a typical run

```
[setup:validate] key lengths: { consumer_key: 25, consumer_secret: 50, access_token: 50, access_secret: 45 }
[supabase] connecting to: https://nxkpthesrtlwbcwhavqn.supabase.co | key length: 221
[setup:validate] SUPABASE ERROR: Invalid API key { urlInUse: 'https://nxkpthesrtlwbcwhavqn.supabase.co', keyLen: 221 }
```

---

## What We Know for Certain

| Fact | Evidence |
|------|----------|
| X credential check passes | `verifyCredentials()` returns `@FaboRoque` with no error |
| Supabase URL is correct | `https://nxkpthesrtlwbcwhavqn.supabase.co` — matches Supabase dashboard |
| Key is being trimmed | `.trim()` applied in both Zod schema and `getSupabase()` before `createClient()` |
| Key length in Railway is 221 chars | Logged on every request |
| 221 chars matches old leaked key | The original `service_role` key was accidentally posted in a dev chat then regenerated — the old key is 221 chars. A regenerate invalidates the old value. |
| New key was NOT pasted into Railway | Railway still holds the 221-char old (revoked) value |

---

## Root Cause (Our Assessment)

The Supabase project's `service_role` secret key was regenerated (after being accidentally
exposed in a chat log). **Railway's `SUPABASE_SERVICE_KEY` env var was never updated** — it
still holds the old revoked 221-char key. Supabase rejects it with "Invalid API key".

This is an infrastructure/config issue, not a code bug.

---

## What We Have Tried (Chronological)

### 1. Switched X validation from v2 to v1

Changed from `client.v2.me()` to `client.v1.verifyCredentials()`.  
**Result:** X auth now works and returns the user object. ✅  
Still not the cause of the Supabase failure.

### 2. Added Unicode sanitization

`input.replace(/[^\x20-\x7E]/g, "").trim()` on all wizard step inputs — Telegram
copy-paste injects zero-width spaces and other invisible Unicode that can corrupt key values.  
**Result:** Confirmed keys are clean printable ASCII. ✅  
Still not the cause of the Supabase failure.

### 3. Dumped raw X error JSON to Telegram

Surfaced the full `JSON.stringify(err, Object.getOwnPropertyNames(err))` of any X auth
failure directly into the Telegram reply.  
**Result:** Confirmed X auth was passing silently, the error was actually thrown by the
Supabase block, not the X block.

### 4. Split X and Supabase errors into separate try/catch blocks

Previously both were in one `try`. Added a second `catch` block specifically around
`upsertUser()` so the error source is unambiguous.  
**Result:** Confirmed 100% — the error is from `upsertUser()` (Supabase), not from `verifyCredentials()` (X). ✅

### 5. Logged URL and key length/preview in Supabase catch block

```typescript
const urlInUse = config.SUPABASE_URL ?? "(not set)";
const keyLen = config.SUPABASE_SERVICE_KEY?.length ?? 0;
const keyPreview = config.SUPABASE_SERVICE_KEY?.slice(0, 20) + "…" + config.SUPABASE_SERVICE_KEY?.slice(-6);
console.error("[setup:validate] SUPABASE ERROR:", dbErr?.message, { urlInUse, keyLen });
```
**Result:** URL confirmed correct. Key length is 221 — identified as matching the old revoked key.

### 6. Added `.trim()` to Zod schema and createClient() call

```typescript
// config.ts
SUPABASE_URL: z.string().trim().url().optional(),
SUPABASE_SERVICE_KEY: z.string().trim().min(10).optional(),

// userStore.ts
const url = config.SUPABASE_URL.trim();
const key = config.SUPABASE_SERVICE_KEY.trim();
console.log("[supabase] connecting to:", url, "| key length:", key.length);
_supabase = createClient(url, key);
```
**Result:** Ruled out whitespace as a cause. Key is clean entering `createClient()`.

---

## Current Code

### `src/db/userStore.ts` — getSupabase()

```typescript
export function getSupabase(): SupabaseClient {
    if (_supabase) return _supabase;
    if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_KEY) {
        throw new Error(
            "Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Railway env vars."
        );
    }
    const url = config.SUPABASE_URL.trim();
    const key = config.SUPABASE_SERVICE_KEY.trim();
    console.log("[supabase] connecting to:", url, "| key length:", key.length);
    _supabase = createClient(url, key);
    return _supabase;
}
```

### `src/db/userStore.ts` — upsertUser()

```typescript
export async function upsertUser(user: UserRecord): Promise<void> {
    const db = getSupabase();
    const { error } = await db
        .from("xclaw_users")
        .upsert(user, { onConflict: "telegram_id" });
    if (error) throw error;
}
```

### `src/claws/listen/router.ts` — Step 2: Save to Supabase (inside handleSetupWizard)

```typescript
// ── Step 2: Save to Supabase ───────────────────────────────────
try {
    await upsertUser({
        telegram_id: telegramId,
        x_user_id: String(xMe.id_str ?? xMe.id),
        x_username: xMe.screen_name,
        x_consumer_key: wizard.partial.consumer_key!,
        x_consumer_secret: wizard.partial.consumer_secret!,
        x_access_token: wizard.partial.access_token!,
        x_access_secret: trimmed,
    });
    invalidateUserXClient(telegramId);
} catch (dbErr: any) {
    const urlInUse = config.SUPABASE_URL ?? "(not set)";
    const keyLen = config.SUPABASE_SERVICE_KEY?.length ?? 0;
    const keyPreview = config.SUPABASE_SERVICE_KEY
        ? config.SUPABASE_SERVICE_KEY.slice(0, 20) + "…" + config.SUPABASE_SERVICE_KEY.slice(-6)
        : "(not set)";
    console.error("[setup:validate] SUPABASE ERROR:", dbErr?.message, { urlInUse, keyLen });
    ctx.session.setupWizard = null;
    await ctx.api.editMessageText(
        ctx.chat?.id ?? telegramId,
        validating.message_id,
        `⚠️ *X credentials valid (@${xMe.screen_name}) but Supabase rejected the key.*\n\n` +
        `*Error:* \`${dbErr?.message ?? "unknown"}\`\n\n` +
        `*What Railway is sending to Supabase:*\n` +
        `• URL: \`${urlInUse}\`\n` +
        `• Key (${keyLen} chars): \`${keyPreview}\`\n\n` +
        `⚠️ Make sure the URL and key are from the *same* Supabase project.\n` +
        `Go to Supabase → your project → Settings → API and verify both match.\n\n` +
        `Then update Railway Variables and redeploy.`,
        { parse_mode: "Markdown" }
    );
    break;
}
```

---

## Supabase Project Details

- **Project URL:** `https://nxkpthesrtlwbcwhavqn.supabase.co`
- **Shared with:** Reply-Guy and XCUE Chrome extension use the same Supabase project
- **IMPORTANT:** The **JWT secret must NOT be regenerated** — doing so would invalidate all
  existing auth sessions for Reply-Guy and XCUE users
- **What CAN be regenerated safely:** The `service_role` API key (independent of JWT secret)
- **Status of `xclaw_users` table:** Needs to be confirmed — may not have been created yet

### Required table SQL

```sql
CREATE TABLE IF NOT EXISTS xclaw_users (
  telegram_id        BIGINT      PRIMARY KEY,
  x_user_id          TEXT,
  x_username         TEXT,
  x_consumer_key     TEXT        NOT NULL,
  x_consumer_secret  TEXT        NOT NULL,
  x_access_token     TEXT        NOT NULL,
  x_access_secret    TEXT        NOT NULL,
  mention_allowlist  TEXT,
  dm_allowlist       TEXT,
  created_at         TIMESTAMPTZ DEFAULT now()
);
```

---

## The Fix (In Progress)

**Two things need to happen — neither requires code changes:**

### Fix 1 — Replace the Supabase key in Railway

1. Supabase Dashboard → Project `nxkpthesrtlwbcwhavqn` → **Project Settings → API**
2. Under **"Secret keys"** → click **"New secret key"** → name it `xclaw`
3. Copy the value shown **immediately** (shown only once)
4. Railway → Project → Variables → `SUPABASE_SERVICE_KEY` → paste new value → Save
5. Railway redeploys automatically

### Fix 2 — Confirm `xclaw_users` table exists

1. Supabase → SQL Editor → run the CREATE TABLE SQL above
2. If table already exists, the `IF NOT EXISTS` guard means it's a no-op

---

## Environment

- **Supabase JS SDK:** `@supabase/supabase-js` (latest)
- **Node.js:** 20+
- **TypeScript:** 5.7
- **Deployed on:** Railway (auto-deploys on push to main)
- **Supabase project:** shared between Xclaw, Reply-Guy, XCUE Chrome extension

---

## What Success Looks Like

When both fixes are applied and Railway redeploys, the Railway log should show:

```
[supabase] connecting to: https://nxkpthesrtlwbcwhavqn.supabase.co | key length: <new key length>
```

And the `/setup` Telegram flow should complete with:

```
✅ Connected as @FaboRoque!
Your credentials are stored securely in the database.
✅ Real-time alerts active! DMs and mentions will arrive here instantly.
Webhook ID: <id>
```

---

## What a Senior Dev Might Want to Verify

1. **Is "Invalid API key" from Supabase always a revoked/wrong key, or can it indicate
   something else?** (e.g. wrong key type — using `anon` key instead of `service_role`?
   key for wrong project? key format changed after a Supabase upgrade?)

2. **Is there a way to test the Supabase key directly** (e.g. a `curl` against
   `https://nxkpthesrtlwbcwhavqn.supabase.co/rest/v1/xclaw_users` with the
   `Authorization: Bearer <key>` and `apikey: <key>` headers) to confirm it's valid
   before deploying to Railway?

3. **Could the `_supabase` singleton cache be holding a bad client** across hot reloads?
   If Railway didn't fully restart when the key was last changed, the old (bad) client
   instance might be cached in `_supabase`. The singleton is only cleared on process restart.

4. **Does Railway's variable replacement guarantee the value contains no invisible chars?**
   We `.trim()` the value, but Railway's UI has been known to add a trailing newline in
   some edge cases. Could the key still be malformed in a way `.trim()` doesn't catch?

---

## Questions for the Senior Dev

1. Is there any Supabase scenario where "Invalid API key" is thrown for a reason other
   than a wrong/revoked key? (e.g. IP blocklist, project paused, rate limit?)

2. For the shared Supabase project — is there a risk that creating a new project-scoped
   secret key (instead of using the global `service_role` key) behaves differently in
   terms of RLS or table access permissions?

3. After we get this unblocked — is there anything else we should audit in the
   Supabase → Railway integration that commonly causes issues at this level?
