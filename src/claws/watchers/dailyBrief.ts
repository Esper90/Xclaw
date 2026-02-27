import cron from "node-cron";
import { hasUserXCreds } from "../../db/getUserClient";
import { listAllUsers } from "../../db/userStore";
import { getUserProfile, updateUserProfile } from "../../db/profileStore";
import { performTavilySearch } from "../wire/tools/web_search";
import { checkAndConsumeTavilyBudget, checkAndConsumeXBudget } from "../sense/apiBudget";
import { fetchMentions } from "../wire/xButler";
import { getUpcomingReminders } from "../../db/reminders";

const CHECK_CRON = "*/5 * * * *"; // check every 5 minutes
const BRIEF_WINDOW_MINUTES = 10; // fire within 10 minutes after 07:30 local
const MIN_HOURS_BETWEEN_BRIEFS = 23; // guard against double-sends
const NEWS_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // reuse news within 6h

type BriefSections = {
    headlines: string;
    mentions: string;
    calendar: string;
    weather: string;
    reminders: string;
    vibe: string;
};

function getLocalTimeParts(timezone: string | null | undefined): { hour: number; minute: number } {
    const tz = timezone || "UTC";
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
    });
    const parts = formatter.formatToParts(now);
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
    return { hour, minute };
}

function isWithinBriefWindow(timezone: string | null | undefined): boolean {
    const { hour, minute } = getLocalTimeParts(timezone);
    if (hour !== 7) return false;
    return minute >= 30 && minute < 30 + BRIEF_WINDOW_MINUTES;
}

function sentRecently(lastSent: string | null | undefined): boolean {
    if (!lastSent) return false;
    const delta = Date.now() - Date.parse(lastSent);
    return delta < MIN_HOURS_BETWEEN_BRIEFS * 60 * 60 * 1000;
}

function formatBulletList(lines: string[], max = 5): string {
    return lines
        .filter(Boolean)
        .slice(0, max)
        .map((line) => `• ${line.trim()}`)
        .join("\n");
}

function formatWithTz(iso: string, timezone: string | null | undefined): string {
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone || "UTC",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
    return formatter.format(new Date(iso));
}

async function buildHeadlinesSection(
    telegramId: number,
    prefs: Record<string, unknown>,
    setDigest: (digest: { topics: string[]; bullets: string[]; ts: number }) => void
): Promise<string> {
    const existing = (prefs as any).newsDigest as { bullets?: string[]; ts?: number; topics?: string[] } | undefined;
    const topics = Array.isArray((prefs as any).newsTopics) ? (prefs as any).newsTopics as string[] : [];
    const now = Date.now();
    const fresh = existing?.bullets && existing.bullets.length > 0 && typeof existing.ts === "number" && now - existing.ts < NEWS_CACHE_MAX_AGE_MS;

    if (fresh) {
        return `Headlines (cached):\n${formatBulletList(existing!.bullets)}`;
    }

    const budget = await checkAndConsumeTavilyBudget(telegramId);
    if (!budget.allowed) {
        if (existing?.bullets?.length) {
            return `Headlines (cached):\n${formatBulletList(existing.bullets)}\n_(live search skipped: ${budget.reason})_`;
        }
        return `Headlines: Tavily limit hit (${budget.reason}).`;
    }

    try {
        const query = topics.length ? `top news for ${topics.join(", ")}, 5 concise bullets` : "today's top world and tech news headlines, 5 concise bullets";
        const raw = await performTavilySearch(query, 5);
        const bullets = raw
            .split("\n")
            .filter((line) => line.includes("]("))
            .map((line) => line.trim())
            .slice(0, 5);

        if (!bullets.length) return "Headlines: No relevant search results.";
        setDigest({ topics, bullets, ts: now });
        return `Headlines:\n${formatBulletList(bullets)}`;
    } catch (err: any) {
        console.warn(`[daily-brief] Tavily failed for ${telegramId}:`, err);
        if (existing?.bullets?.length) return `Headlines (cached):\n${formatBulletList(existing.bullets)}\n_(live search failed: ${err?.message ?? "error"})_`;
        return `Headlines: search unavailable (${err?.message ?? "error"}).`;
    }
}

async function buildMentionsSection(telegramId: number, hasX: boolean): Promise<string> {
    if (!hasX) return "X mentions: Add your X keys via /setup to include mentions.";

    const budget = await checkAndConsumeXBudget(telegramId);
    if (!budget.allowed) return `X mentions: paused (${budget.reason}).`;

    try {
        const mentions = await fetchMentions(String(telegramId), 5, undefined, /* cheapMode */ true);
        if (mentions.length === 0) return "X mentions: Nothing important in the last fetch window.";

        const bullets = mentions.map((m) => {
            const author = m.authorUsername ? `@${m.authorUsername}` : m.authorId;
            const preview = m.text.length > 110 ? `${m.text.slice(0, 110)}…` : m.text;
            return `${author}: ${preview}`;
        });

        return `X mentions:\n${formatBulletList(bullets, 5)}`;
    } catch (err: any) {
        console.warn(`[daily-brief] Mentions failed for ${telegramId}:`, err);
        return `X mentions: fetch failed (${err?.message ?? "error"}).`;
    }
}

async function buildCalendarSection(telegramId: number, timezone: string | null | undefined): Promise<string> {
    const upcoming = await getUpcomingReminders(telegramId, 3);
    if (!upcoming.length) return "Calendar: No upcoming reminders. Use /remind to add.";
    const bullets = upcoming.map((r) => {
        const when = formatWithTz(r.remind_at, timezone);
        return `${when}: ${r.text}`;
    });
    return `Calendar:\n${formatBulletList(bullets, 3)}`;
}

async function buildWeatherSection(profileTz: string | null | undefined, prefs: Record<string, unknown> | null | undefined): Promise<string> {
    const rawLoc = (prefs as any)?.weatherLocation
        ?? (profileTz && profileTz.includes("/") ? profileTz.split("/").pop()!.replace(/_/g, " ") : null);
    const loc = typeof rawLoc === "string" ? rawLoc.trim().replace(/\s+/g, " ") : null;
    if (!loc || loc.length === 0) return "Weather: Set a location in prefs (weatherLocation) to include today's weather.";
    if (loc.length > 80) return "Weather: Location looks too long; please shorten weatherLocation in prefs.";

    try {
        const res = await fetch(`https://wttr.in/${encodeURIComponent(loc)}?format=3`);
        if (!res.ok) return `Weather: lookup failed (${res.status}).`;
        const text = (await res.text()).trim();
        if (!text || /unknown location/i.test(text) || /404/i.test(text)) {
            return `Weather: location "${loc}" not found. Update weatherLocation in prefs.`;
        }
        return `Weather: ${text}`;
    } catch (err: any) {
        return `Weather: unavailable (${err?.message ?? "error"}).`;
    }
}

function buildRemindersSection(
    wishlist: Array<{ item: string; targetPrice?: number }> = [],
    upcoming: Array<{ remind_at: string; text: string }> = [],
    timezone?: string | null
): string {
    const lines: string[] = [];
    if (upcoming.length > 0) {
        lines.push("Upcoming reminders:");
        lines.push(...upcoming.map((r) => `${formatWithTz(r.remind_at, timezone)}: ${r.text}`));
    }
    if (wishlist.length > 0) {
        lines.push("Wishlist targets:");
        lines.push(...wishlist.slice(0, 3).map((w) => `${w.item}${w.targetPrice ? ` (target $${w.targetPrice})` : ""}`));
    }
    if (!lines.length) return "Reminders: Add reminders or wishlist items to get nudges.";
    return `Reminders:\n${formatBulletList(lines, 6)}`;
}

function buildVibeSection(): string {
    return "Vibe check: Feeling good today? Reply with yes/no and I'll schedule a recharge block if needed.";
}

function renderBrief(sections: BriefSections): string {
    return [
        "📅 Daily Butler Brief",
        "",
        sections.headlines,
        sections.mentions,
        sections.calendar,
        sections.weather,
        sections.reminders,
        sections.vibe,
        "",
        "Buttons: Read full | Dismiss | Schedule follow-up",
    ]
        .filter(Boolean)
        .join("\n");
}

function isQuiet(prefs: Record<string, any>): boolean {
    if ((prefs as any).quietAll) return true;
    const start = Number(prefs.quietHoursStart);
    const end = Number(prefs.quietHoursEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    if (start === end) return false;
    const hour = new Date().getHours();
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
}

export function startDailyBriefWatcher(
    sendMessage: (chatId: number, text: string, extra?: { reply_markup?: any }) => Promise<void>
): void {
    cron.schedule(CHECK_CRON, async () => {
        try {
            const users = await listAllUsers();
            if (!users || users.length === 0) return;

            for (const user of users) {
                const telegramId = user.telegram_id;
                const profile = await getUserProfile(telegramId);
                const prefs = (profile.prefs || {}) as Record<string, any>;
                if (isQuiet(prefs)) continue;

                if (sentRecently(profile.briefLastSentAt)) continue;
                if (!isWithinBriefWindow(profile.timezone)) continue;

                const hasX = await hasUserXCreds(telegramId);
                const upcomingReminders = await getUpcomingReminders(telegramId, 3);
                const newPrefs = { ...prefs } as Record<string, any>;
                let prefsChanged = false;
                const sections: BriefSections = {
                    headlines: await buildHeadlinesSection(telegramId, prefs, (digest) => {
                        newPrefs.newsDigest = digest;
                        prefsChanged = true;
                    }),
                    mentions: await buildMentionsSection(telegramId, hasX),
                    calendar: await buildCalendarSection(telegramId, profile.timezone),
                    weather: await buildWeatherSection(profile.timezone, profile.prefs),
                    reminders: buildRemindersSection(profile.wishlist ?? [], upcomingReminders, profile.timezone),
                    vibe: buildVibeSection(),
                };

                const message = renderBrief(sections);
                const reply_markup = {
                    inline_keyboard: [
                        [
                            { text: "Read full", callback_data: "brief:read" },
                            { text: "Dismiss", callback_data: "brief:dismiss" },
                        ],
                        [
                            { text: "Schedule follow-up", callback_data: "brief:follow" },
                        ],
                    ],
                };

                try {
                    await sendMessage(telegramId, message, { reply_markup });
                    await updateUserProfile(telegramId, {
                        briefLastSentAt: new Date().toISOString(),
                        briefCache: sections,
                        ...(prefsChanged ? { prefs: newPrefs } : {}),
                    });
                    console.log(`[daily-brief] Sent brief to user ${telegramId} (hasX=${hasX})`);
                } catch (err) {
                    console.error(`[daily-brief] Failed to send brief to user ${telegramId}:`, err);
                }
            }
        } catch (err) {
            console.error("[daily-brief] Loop failed:", err);
        }
    });

    console.log(`[daily-brief] Scheduler active — cron: "${CHECK_CRON}"`);
}
