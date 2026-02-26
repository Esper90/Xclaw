/**
 * Per-user X API client factory — Xclaw
 *
 * Returns a TwitterApi (OAuth 1.0a) instance for a given Telegram user ID.
 *
 * Resolution order:
 *   1. In-memory TTL cache (fast path — avoids DB hits on every message)
 *   2. Supabase xclaw_users row (user-owned keys model)
 *   3. Legacy env-var credentials (single-user backward compat — no DB needed)
 *
 * Call `invalidateUserXClient(telegramId)` after saving new credentials to DB
 * so the next call picks up the fresh tokens.
 */

import { TwitterApi } from "twitter-api-v2";
import { config } from "../config";
import { getUser, isSupabaseConfigured } from "./userStore";

// ── TTL cache ─────────────────────────────────────────────────────────────────
// Clients are safe to cache long-term (tokens don't expire for OAuth 1.0a).
// We use a 1-hour TTL as a safety valve so credential updates in DB propagate.
const _cache = new Map<number, { client: TwitterApi; ts: number }>();
const TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Return a ready-to-use TwitterApi client for the given Telegram user.
 * Throws if no credentials are found anywhere (neither DB nor env vars).
 */
export async function getUserXClient(telegramId: number | string): Promise<TwitterApi> {
    const numId = typeof telegramId === "string" ? parseInt(telegramId, 10) : telegramId;

    // 1. Cache check
    const cached = _cache.get(numId);
    if (cached && Date.now() - cached.ts < TTL_MS) return cached.client;

    // 2. Supabase check (user-owned keys)
    if (isSupabaseConfigured()) {
        try {
            const user = await getUser(numId);
            if (user) {
                const client = new TwitterApi({
                    appKey: user.x_consumer_key,
                    appSecret: user.x_consumer_secret,
                    accessToken: user.x_access_token,
                    accessSecret: user.x_access_secret,
                });
                _cache.set(numId, { client, ts: Date.now() });
                return client;
            }
        } catch (err) {
            console.warn(`[getUserXClient] Supabase lookup failed for telegramId=${numId}:`, err);
        }
    }

    // 3. Legacy env-var fallback (single hardcoded user — for existing deploys)
    if (
        config.X_CONSUMER_KEY &&
        config.X_CONSUMER_SECRET &&
        config.X_ACCESS_TOKEN &&
        config.X_ACCESS_SECRET
    ) {
        const client = new TwitterApi({
            appKey: config.X_CONSUMER_KEY,
            appSecret: config.X_CONSUMER_SECRET,
            accessToken: config.X_ACCESS_TOKEN,
            accessSecret: config.X_ACCESS_SECRET,
        });
        return client;
    }

    throw new Error(
        "X credentials not set up. Send /setup in Telegram to connect your X account."
    );
}

/**
 * Lightweight check to see if we have X creds for a user (Supabase row or env fallback).
 */
export async function hasUserXCreds(telegramId: number | string): Promise<boolean> {
    const numId = typeof telegramId === "string" ? parseInt(telegramId, 10) : telegramId;

    if (isSupabaseConfigured()) {
        try {
            const user = await getUser(numId);
            if (
                user?.x_consumer_key &&
                user?.x_consumer_secret &&
                user?.x_access_token &&
                user?.x_access_secret
            ) {
                return true;
            }
        } catch (err) {
            console.warn(`[hasUserXCreds] Supabase lookup failed for telegramId=${numId}:`, err);
        }
    }

    return !!(
        config.X_CONSUMER_KEY &&
        config.X_CONSUMER_SECRET &&
        config.X_ACCESS_TOKEN &&
        config.X_ACCESS_SECRET
    );
}

/** Force-evict a user's cached client — call after saving new credentials to DB. */
export function invalidateUserXClient(telegramId: number | string): void {
    const numId = typeof telegramId === "string" ? parseInt(telegramId, 10) : telegramId;
    _cache.delete(numId);
}
