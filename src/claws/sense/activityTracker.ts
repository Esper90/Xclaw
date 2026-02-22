/**
 * Activity Tracker
 * Lightweight in-memory store that records the last time each user sent a
 * message to the bot.  Used by the Butler background watcher to skip users
 * who haven't been active recently (avoids polling X on behalf of idle users).
 */

// userId → epoch ms of last activity
const lastSeen = new Map<string, number>();

/**
 * Record that a user was active right now.
 * Call this in textHandler and voiceHandler.
 */
export function recordActivity(userId: string): void {
    lastSeen.set(userId, Date.now());
}

/**
 * Return all user IDs whose last activity was within `withinMs` milliseconds.
 */
export function getRecentlyActiveUsers(withinMs: number): string[] {
    const cutoff = Date.now() - withinMs;
    const active: string[] = [];
    for (const [userId, ts] of lastSeen.entries()) {
        if (ts >= cutoff) active.push(userId);
    }
    return active;
}

/**
 * Return the epoch ms of a user's last activity, or 0 if never seen.
 */
export function getLastActivity(userId: string): number {
    return lastSeen.get(userId) ?? 0;
}
