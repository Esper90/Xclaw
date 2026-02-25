import { getSupabase } from "./userStore";

export interface ProfileCacheRecord {
    handle: string;
    profile_data: any;
    tweets_data: any[];
    fetched_at: string;
}

/**
 * Fetch a cached X profile by handle.
 * Returns null if it doesn't exist or is older than 24 hours.
 */
export async function getCachedProfile(handle: string): Promise<ProfileCacheRecord | null> {
    const db = getSupabase();
    const normalizedHandle = handle.toLowerCase().replace("@", "");

    const { data, error } = await db
        .from("xclaw_profile_cache")
        .select("*")
        .eq("handle", normalizedHandle)
        .single();

    if (error?.code === "PGRST116" || !data) return null; // Not found
    if (error) throw error;

    // Check if older than 24 hours
    const fetchedAt = new Date(data.fetched_at).getTime();
    const now = Date.now();
    const hours24 = 24 * 60 * 60 * 1000;

    if (now - fetchedAt > hours24) {
        return null; // Cache expired
    }

    return data as ProfileCacheRecord;
}

/**
 * Save or update a profile in the cache.
 */
export async function setCachedProfile(handle: string, profileData: any, tweetsData: any[]): Promise<void> {
    const db = getSupabase();
    const normalizedHandle = handle.toLowerCase().replace("@", "");

    const record = {
        handle: normalizedHandle,
        profile_data: profileData,
        tweets_data: tweetsData,
        fetched_at: new Date().toISOString()
    };

    const { error } = await db
        .from("xclaw_profile_cache")
        .upsert(record, { onConflict: "handle" });

    if (error) throw error;
}

/**
 * Delete a profile from the cache.
 * Useful when a user revokes their keys and we want to wipe their cached presence.
 */
export async function deleteCachedProfile(handle: string): Promise<void> {
    const db = getSupabase();
    const normalizedHandle = handle.toLowerCase().replace("@", "");

    const { error } = await db
        .from("xclaw_profile_cache")
        .delete()
        .eq("handle", normalizedHandle);

    if (error) throw error;
}
