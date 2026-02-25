/**
 * Adaptive Token Bucket Rate Limiter
 * 
 * Prevents API flood abuse without punishing power users.
 * Allows bursty behavior (e.g., 20 voice notes in a row) but enforces
 * a steady long-term rate (e.g., 1 message every 5 seconds).
 */

const MAX_TOKENS = 20;            // Maximum burst capacity
const REFILL_RATE_MS = 5000;      // 1 token refills every 5 seconds

interface TokenBucket {
    tokens: number;
    lastRefill: number;
}

// In-memory store: Telegram ID -> Bucket State
const buckets = new Map<string, TokenBucket>();

/**
 * Attempt to consume 1 token for a given user.
 * Returns true if allowed, false if rate limited.
 */
export function consumeToken(userId: string): boolean {
    const now = Date.now();
    let bucket = buckets.get(userId);

    if (!bucket) {
        // First time seeing this user: give full bucket, consume 1
        buckets.set(userId, { tokens: MAX_TOKENS - 1, lastRefill: now });
        return true;
    }

    // Calculate how many tokens to refill based on time passed
    const timePassed = now - bucket.lastRefill;
    const tokensToAdd = Math.floor(timePassed / REFILL_RATE_MS);

    if (tokensToAdd > 0) {
        bucket.tokens = Math.min(MAX_TOKENS, bucket.tokens + tokensToAdd);

        // Only advance lastRefill by the exact interval amount added, 
        // to preserve fractional millisecond progress towards the next token.
        bucket.lastRefill += tokensToAdd * REFILL_RATE_MS;
    }

    if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return true;
    }

    // Rate limited
    return false;
}
