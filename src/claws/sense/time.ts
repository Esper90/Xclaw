const TZ_ALIASES: Record<string, string> = {
    UTC: "UTC",
    GMT: "UTC",
    PST: "America/Los_Angeles",
    PDT: "America/Los_Angeles",
    MST: "America/Denver",
    MDT: "America/Denver",
    CST: "America/Chicago",
    CDT: "America/Chicago",
    EST: "America/New_York",
    EDT: "America/New_York",
};

function canUseTimeZone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
        return true;
    } catch {
        return false;
    }
}

export function normalizeTimeZoneOrNull(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const aliased = TZ_ALIASES[trimmed.toUpperCase()] ?? trimmed;
    if (!canUseTimeZone(aliased)) return null;
    return aliased;
}

export function resolveTimeZone(raw: string | null | undefined): string {
    return normalizeTimeZoneOrNull(raw) ?? "UTC";
}

export function getLocalDayKey(
    timezone: string | null | undefined,
    at: number | Date = Date.now()
): string {
    const tz = resolveTimeZone(timezone);
    const date = at instanceof Date ? at : new Date(at);
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);

    const year = parts.find((p) => p.type === "year")?.value ?? "1970";
    const month = parts.find((p) => p.type === "month")?.value ?? "01";
    const day = parts.find((p) => p.type === "day")?.value ?? "01";
    return `${year}-${month}-${day}`;
}

export function getLocalHour(timezone: string | null | undefined, at: number | Date = Date.now()): number {
    const tz = resolveTimeZone(timezone);
    const date = at instanceof Date ? at : new Date(at);
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        hour: "2-digit",
    }).formatToParts(date);

    const hourRaw = parts.find((p) => p.type === "hour")?.value ?? "0";
    const hour = Number.parseInt(hourRaw, 10);
    return Number.isFinite(hour) ? hour : 0;
}

export function formatNowForUser(timezone: string | null | undefined): string {
    const tz = resolveTimeZone(timezone);
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
        month: "short",
        day: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
        timeZoneName: "short",
    });
    return formatter.format(new Date());
}
