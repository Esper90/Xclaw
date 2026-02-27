import { getUserProfile, updateUserProfile } from "../../db/profileStore";

// Budget ceilings (configurable via envs; exposed for settings UI)
export const DEFAULT_TAVILY_DAILY_MAX = Number(process.env.TAVILY_DAILY_MAX ?? 12); // raised from 6
export const DEFAULT_X_HOURLY_MAX = Number(process.env.X_HOURLY_MAX ?? 3);
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

function resolveCeiling(raw: unknown, fallback: number, min = 1, max = 100): number {
    const num = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
    if (!Number.isFinite(num)) return fallback;
    const clamped = Math.max(min, Math.min(max, Math.floor(num)));
    return clamped;
}

function setUsageCounters(
    prefs: Record<string, unknown>,
    key: "tavily" | "x",
    count: number
): Record<string, unknown> {
    const next = { ...prefs } as Record<string, any>;
    const dayKey = new Date().toISOString().slice(0, 10);
    const usage = (next.usage ?? {}) as Record<string, any>;
    usage[key] = { day: dayKey, count };
    next.usage = usage;
    return next;
}

/**
 * Check + consume Tavily budget (daily). Resets window when stale.
 */
export async function checkAndConsumeTavilyBudget(telegramId: number): Promise<BudgetCheckResult> {
    const profile = await getUserProfile(telegramId);
    const prefs = (profile.prefs || {}) as Record<string, unknown>;
    const ceiling = resolveCeiling(prefs.tavilyDailyLimit, DEFAULT_TAVILY_DAILY_MAX);
    let calls = profile.tavilyCallsToday ?? 0;
    let resetAt = profile.tavilyCallsResetAt;

    if (needsReset(resetAt, DAY_MS)) {
        calls = 0;
        resetAt = new Date().toISOString();
    }

    if (calls >= ceiling) {
        return { allowed: false, reason: `Daily Tavily limit reached (${ceiling})` };
    }

    const nextPrefs = setUsageCounters(prefs, "tavily", calls + 1);

    await updateUserProfile(telegramId, {
        tavilyCallsToday: calls + 1,
        tavilyCallsResetAt: resetAt,
        prefs: nextPrefs,
    });
    return { allowed: true };
}

/**
 * Check + consume X budget (hourly). Resets window when stale.
 */
export async function checkAndConsumeXBudget(telegramId: number): Promise<BudgetCheckResult> {
    const profile = await getUserProfile(telegramId);
    const prefs = (profile.prefs || {}) as Record<string, unknown>;
    const ceiling = resolveCeiling(prefs.xHourlyLimit, DEFAULT_X_HOURLY_MAX);
    let calls = profile.xCallsHour ?? 0;
    let resetAt = profile.xCallsResetAt;
    let dayCalls = (prefs as any)?.usage?.x?.count as number | undefined;
    const dayKey = new Date().toISOString().slice(0, 10);
    const lastDay = (prefs as any)?.usage?.x?.day as string | undefined;
    if (!Number.isFinite(dayCalls) || lastDay !== dayKey) dayCalls = 0;

    if (needsReset(resetAt, HOUR_MS)) {
        calls = 0;
        resetAt = new Date().toISOString();
    }

    if (calls >= ceiling) {
        return { allowed: false, reason: `Hourly X API limit reached (${ceiling})` };
    }

    const nextPrefs = setUsageCounters(prefs, "x", (dayCalls ?? 0) + 1);

    await updateUserProfile(telegramId, {
        xCallsHour: calls + 1,
        xCallsResetAt: resetAt,
        prefs: nextPrefs,
    });
    return { allowed: true };
}
