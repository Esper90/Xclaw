import { getSupabase } from "./userStore";

export interface UserProfile {
    timezone?: string | null;
    vipList?: string[];
    wishlist?: Array<{ item: string; targetPrice?: number }>; // free-form wish entries
    watchedRepos?: string[]; // e.g. owner/repo
    briefLastSentAt?: string | null; // ISO
    vibeCheckFreqDays?: number | null;
    lastTweetIds?: Record<string, string>; // handle -> last seen tweet id
    tavilyCallsToday?: number | null;
    tavilyCallsResetAt?: string | null; // ISO
    xCallsHour?: number | null;
    xCallsResetAt?: string | null; // ISO
    briefCache?: Record<string, unknown> | null; // cached brief payload
    xApiKey?: string | null; // BYOK bearer-style key
    prefs?: Record<string, unknown> | null; // general-purpose user prefs
}

const DEFAULT_PROFILE: Required<UserProfile> = {
    timezone: null,
    vipList: [],
    wishlist: [],
    watchedRepos: [],
    briefLastSentAt: null,
    vibeCheckFreqDays: 3,
    lastTweetIds: {},
    tavilyCallsToday: 0,
    tavilyCallsResetAt: null,
    xCallsHour: 0,
    xCallsResetAt: null,
    briefCache: null,
    xApiKey: null,
    prefs: {},
};

function mapRowToProfile(row: Record<string, any> | null): UserProfile {
    if (!row) return { ...DEFAULT_PROFILE };
    return {
        timezone: row.timezone ?? DEFAULT_PROFILE.timezone,
        vipList: row.vip_list ?? DEFAULT_PROFILE.vipList,
        wishlist: row.wishlist ?? DEFAULT_PROFILE.wishlist,
        watchedRepos: row.watched_repos ?? DEFAULT_PROFILE.watchedRepos,
        briefLastSentAt: row.brief_last_sent_at ?? DEFAULT_PROFILE.briefLastSentAt,
        vibeCheckFreqDays: row.vibe_check_freq_days ?? DEFAULT_PROFILE.vibeCheckFreqDays,
        lastTweetIds: row.last_tweet_ids ?? DEFAULT_PROFILE.lastTweetIds,
        tavilyCallsToday: row.tavily_calls_today ?? DEFAULT_PROFILE.tavilyCallsToday,
        tavilyCallsResetAt: row.tavily_calls_reset_at ?? DEFAULT_PROFILE.tavilyCallsResetAt,
        xCallsHour: row.x_calls_hour ?? DEFAULT_PROFILE.xCallsHour,
        xCallsResetAt: row.x_calls_reset_at ?? DEFAULT_PROFILE.xCallsResetAt,
        briefCache: row.brief_cache ?? DEFAULT_PROFILE.briefCache,
        xApiKey: row.x_api_key ?? DEFAULT_PROFILE.xApiKey,
        prefs: row.prefs ?? DEFAULT_PROFILE.prefs,
    };
}

function profileToDbPatch(patch: Partial<UserProfile>): Record<string, any> {
    const out: Record<string, any> = {};
    if ("timezone" in patch) out.timezone = patch.timezone ?? null;
    if ("vipList" in patch) out.vip_list = patch.vipList ?? [];
    if ("wishlist" in patch) out.wishlist = patch.wishlist ?? [];
    if ("watchedRepos" in patch) out.watched_repos = patch.watchedRepos ?? [];
    if ("briefLastSentAt" in patch) out.brief_last_sent_at = patch.briefLastSentAt ?? null;
    if ("vibeCheckFreqDays" in patch) out.vibe_check_freq_days = patch.vibeCheckFreqDays ?? null;
    if ("lastTweetIds" in patch) out.last_tweet_ids = patch.lastTweetIds ?? {};
    if ("tavilyCallsToday" in patch) out.tavily_calls_today = patch.tavilyCallsToday ?? 0;
    if ("tavilyCallsResetAt" in patch) out.tavily_calls_reset_at = patch.tavilyCallsResetAt ?? null;
    if ("xCallsHour" in patch) out.x_calls_hour = patch.xCallsHour ?? 0;
    if ("xCallsResetAt" in patch) out.x_calls_reset_at = patch.xCallsResetAt ?? null;
    if ("briefCache" in patch) out.brief_cache = patch.briefCache ?? null;
    if ("xApiKey" in patch) out.x_api_key = patch.xApiKey ?? null;
    if ("prefs" in patch) out.prefs = patch.prefs ?? {};
    return out;
}

/** Fetch profile fields for a user, returning defaults when absent. */
export async function getUserProfile(telegramId: number): Promise<UserProfile> {
    const db = getSupabase();
    const { data, error } = await db
        .from("xclaw_users")
        .select(
            "timezone, vip_list, wishlist, watched_repos, brief_last_sent_at, vibe_check_freq_days, last_tweet_ids, tavily_calls_today, tavily_calls_reset_at, x_calls_hour, x_calls_reset_at, brief_cache, x_api_key, prefs"
        )
        .eq("telegram_id", telegramId)
        .single();

    if (error && error.code !== "PGRST116") {
        throw error;
    }

    return mapRowToProfile(data as Record<string, any> | null);
}

/** Merge patch into existing profile row. Does not touch credentials. */
export async function updateUserProfile(
    telegramId: number,
    patch: Partial<UserProfile>
): Promise<void> {
    const dbPatch = profileToDbPatch(patch);
    if (Object.keys(dbPatch).length === 0) return;

    const db = getSupabase();
    const { error } = await db
        .from("xclaw_users")
        .update(dbPatch)
        .eq("telegram_id", telegramId);

    if (error) throw error;
}

/** Utility to reset daily/hourly counters. Callers decide when to invoke. */
export async function resetRateLimits(
    telegramId: number,
    opts: { resetTavily?: boolean; resetX?: boolean }
): Promise<void> {
    const patch: Partial<UserProfile> = {};
    if (opts.resetTavily) {
        patch.tavilyCallsToday = 0;
        patch.tavilyCallsResetAt = new Date().toISOString();
    }
    if (opts.resetX) {
        patch.xCallsHour = 0;
        patch.xCallsResetAt = new Date().toISOString();
    }
    await updateUserProfile(telegramId, patch);
}

/** Utility to bump counters; callers must enforce ceilings. */
export async function bumpRateCounters(
    telegramId: number,
    opts: { tavilyDelta?: number; xDelta?: number }
): Promise<void> {
    const current = await getUserProfile(telegramId);
    const patch: Partial<UserProfile> = {};
    if (opts.tavilyDelta) {
        patch.tavilyCallsToday = (current.tavilyCallsToday ?? 0) + opts.tavilyDelta;
    }
    if (opts.xDelta) {
        patch.xCallsHour = (current.xCallsHour ?? 0) + opts.xDelta;
    }
    await updateUserProfile(telegramId, patch);
}
