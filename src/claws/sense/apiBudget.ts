import { getUserProfile, updateUserProfile } from "../../db/profileStore";

// Budget ceilings (can be made configurable via envs)
const TAVILY_DAILY_MAX = 2;
const X_HOURLY_MAX = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface BudgetCheckResult {
    allowed: boolean;
    reason?: string;
}

function needsReset(ts: string | null | undefined, windowMs: number): boolean {
    if (!ts) return true;
    const last = Date.parse(ts);
    if (Number.isNaN(last)) return true;
    return Date.now() - last >= windowMs;
}

/**
 * Check + consume Tavily budget (daily). Resets window when stale.
 */
export async function checkAndConsumeTavilyBudget(telegramId: number): Promise<BudgetCheckResult> {
    const profile = await getUserProfile(telegramId);
    let calls = profile.tavilyCallsToday ?? 0;
    let resetAt = profile.tavilyCallsResetAt;

    if (needsReset(resetAt, DAY_MS)) {
        calls = 0;
        resetAt = new Date().toISOString();
    }

    if (calls >= TAVILY_DAILY_MAX) {
        return { allowed: false, reason: "Daily Tavily limit reached" };
    }

    await updateUserProfile(telegramId, {
        tavilyCallsToday: calls + 1,
        tavilyCallsResetAt: resetAt,
    });
    return { allowed: true };
}

/**
 * Check + consume X budget (hourly). Resets window when stale.
 */
export async function checkAndConsumeXBudget(telegramId: number): Promise<BudgetCheckResult> {
    const profile = await getUserProfile(telegramId);
    let calls = profile.xCallsHour ?? 0;
    let resetAt = profile.xCallsResetAt;

    if (needsReset(resetAt, HOUR_MS)) {
        calls = 0;
        resetAt = new Date().toISOString();
    }

    if (calls >= X_HOURLY_MAX) {
        return { allowed: false, reason: "Hourly X API limit reached" };
    }

    await updateUserProfile(telegramId, {
        xCallsHour: calls + 1,
        xCallsResetAt: resetAt,
    });
    return { allowed: true };
}
