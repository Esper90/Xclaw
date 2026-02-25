/**
 * Supabase user store — Xclaw
 *
 * Stores per-user X API credentials and settings.
 * Each Telegram user who runs /setup gets one row here.
 *
 * ── SQL — run once in Supabase SQL editor ────────────────────────────────────
 *
 *   CREATE TABLE IF NOT EXISTS xclaw_users (
 *     telegram_id        BIGINT      PRIMARY KEY,
 *     x_user_id          TEXT,
 *     x_username         TEXT,
 *     x_consumer_key     TEXT        NOT NULL,
 *     x_consumer_secret  TEXT        NOT NULL,
 *     x_access_token     TEXT        NOT NULL,
 *     x_access_secret    TEXT        NOT NULL,
 *     mention_allowlist  TEXT,
 *     dm_allowlist       TEXT,
 *     timezone           TEXT,
 *     created_at         TIMESTAMPTZ DEFAULT now()
 *   );
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config";

export interface UserRecord {
    telegram_id: number;
    x_user_id?: string | null;
    x_username?: string | null;
    x_consumer_key: string;
    x_consumer_secret: string;
    x_access_token: string;
    x_access_secret: string;
    /** Comma-separated handles (no @) — only DMs from these accounts trigger alerts */
    mention_allowlist?: string | null;
    /** Comma-separated handles (no @) — only DMs from these accounts trigger alerts */
    dm_allowlist?: string | null;
    /** User's local timezone (e.g. 'America/Los_Angeles') */
    timezone?: string | null;
    /** If true, the user is globally banned from using Xclaw */
    is_banned?: boolean;
    created_at?: string;
}

// ── Supabase singleton ────────────────────────────────────────────────────────
let _supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
    if (_supabase) return _supabase;
    if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_KEY) {
        throw new Error(
            "Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Railway env vars."
        );
    }
    // Trim both values — Railway sometimes adds trailing whitespace/newlines when pasting
    const url = config.SUPABASE_URL.trim();
    const key = config.SUPABASE_SERVICE_KEY.trim();
    console.log("[supabase] connecting to:", url, "| key length:", key.length);
    _supabase = createClient(url, key);
    return _supabase;
}

export function isSupabaseConfigured(): boolean {
    return !!(config.SUPABASE_URL && config.SUPABASE_SERVICE_KEY);
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/** Fetch a user by their Telegram ID. Returns null if not found. */
export async function getUser(telegramId: number): Promise<UserRecord | null> {
    const db = getSupabase();
    const { data, error } = await db
        .from("xclaw_users")
        .select("*")
        .eq("telegram_id", telegramId)
        .single();
    if (error?.code === "PGRST116") return null; // row not found
    if (error) throw error;
    return data as UserRecord;
}

/** Insert or update a user record. */
export async function upsertUser(user: UserRecord): Promise<void> {
    const db = getSupabase();
    const { error } = await db
        .from("xclaw_users")
        .upsert(user, { onConflict: "telegram_id" });
    if (error) throw error;
}

/** Remove a user's credentials. */
export async function deleteUser(telegramId: number): Promise<void> {
    const db = getSupabase();
    const { error } = await db
        .from("xclaw_users")
        .delete()
        .eq("telegram_id", telegramId);
    if (error) throw error;
}

/**
 * Look up a user by their X numeric user ID.
 * Used by the webhook handler to route incoming events to the right Telegram chat.
 */
export async function getUserByXUserId(xUserId: string): Promise<UserRecord | null> {
    const db = getSupabase();
    const { data, error } = await db
        .from("xclaw_users")
        .select("*")
        .eq("x_user_id", xUserId)
        .single();
    if (error?.code === "PGRST116") return null;
    if (error) throw error;
    return data as UserRecord;
}

/** List all registered users — used by background watchers. */
export async function listAllUsers(): Promise<UserRecord[]> {
    const db = getSupabase();
    const { data, error } = await db.from("xclaw_users").select("*");
    if (error) throw error;
    return (data ?? []) as UserRecord[];
}
