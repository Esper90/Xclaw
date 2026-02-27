import { getLocalDayKey, resolveTimeZone } from "./time";
import { TavilySearchItem, performTavilyNewsSearch } from "../wire/tools/web_search";

export interface CuratedNewsResult {
    bullets: string[];
    sameDayCount: number;
    hasXSource: boolean;
}

function buildNewsQuery(topics: string[], maxItems: number, dayKey: string, includeX: boolean): string {
    const topicLine = topics.length > 0
        ? `latest breaking news about ${topics.join(", ")}`
        : "latest world and tech news";

    const xHint = includeX
        ? "Include relevant x.com links when available."
        : "";

    return `${topicLine}. Focus on items published in the last 24 hours and on ${dayKey}. Return ${maxItems} concise items with source links. ${xHint}`.trim();
}

function getPublishedMs(item: TavilySearchItem): number | null {
    if (!item.publishedAt) return null;
    const ms = Date.parse(item.publishedAt);
    return Number.isNaN(ms) ? null : ms;
}

function cleanHost(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "source";
    }
}

function formatAgeLabel(ms: number | null, timezone: string, localDayKey: string): string {
    if (!ms) return "time unknown";
    const dayKey = getLocalDayKey(timezone, ms);
    if (dayKey === localDayKey) return "today";
    const deltaH = Math.round((Date.now() - ms) / (60 * 60 * 1000));
    if (deltaH <= 1) return "recent";
    return `${deltaH}h ago`;
}

function dedupeByUrl(items: TavilySearchItem[]): TavilySearchItem[] {
    const seen = new Set<string>();
    const out: TavilySearchItem[] = [];
    for (const item of items) {
        const key = item.url || `${item.title}|${item.content.slice(0, 120)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

function rankFreshItems(items: TavilySearchItem[], timezone: string, localDayKey: string): TavilySearchItem[] {
    const withTs = items.map((item) => ({ item, ts: getPublishedMs(item) }));

    withTs.sort((a, b) => {
        const aDay = a.ts ? getLocalDayKey(timezone, a.ts) === localDayKey : false;
        const bDay = b.ts ? getLocalDayKey(timezone, b.ts) === localDayKey : false;
        if (aDay !== bDay) return aDay ? -1 : 1;
        const aTs = a.ts ?? 0;
        const bTs = b.ts ?? 0;
        return bTs - aTs;
    });

    return withTs.map((x) => x.item);
}

export async function fetchCuratedNewsDigest(
    topics: string[],
    opts: { maxItems?: number; timezone?: string | null; includeX?: boolean } = {}
): Promise<CuratedNewsResult> {
    const maxItems = Math.max(2, Math.min(6, Math.floor(opts.maxItems ?? 3)));
    const timezone = resolveTimeZone(opts.timezone);
    const localDayKey = getLocalDayKey(timezone);
    const includeX = opts.includeX !== false;
    const query = buildNewsQuery(topics, maxItems, localDayKey, includeX);

    const rawItems = await performTavilyNewsSearch(query, Math.max(maxItems * 3, 6), 1);
    const unique = dedupeByUrl(rawItems);
    const ranked = rankFreshItems(unique, timezone, localDayKey).slice(0, maxItems);

    const sameDayCount = ranked.filter((item) => {
        const ts = getPublishedMs(item);
        return ts ? getLocalDayKey(timezone, ts) === localDayKey : false;
    }).length;

    const hasXSource = ranked.some((item) => /(^|\.)x\.com$/i.test(cleanHost(item.url)));
    const bullets = ranked.map((item) => {
        const ts = getPublishedMs(item);
        const host = cleanHost(item.url);
        const age = formatAgeLabel(ts, timezone, localDayKey);
        const title = item.title?.trim() || item.content?.trim().slice(0, 120) || "Untitled";
        return `${title} (${host}, ${age}) ${item.url}`.trim();
    });

    return {
        bullets,
        sameDayCount,
        hasXSource,
    };
}
