import { SchemaType } from "@google/generative-ai";
import { config } from "../../../config";
import { checkAndConsumeTavilyBudget } from "../../sense/apiBudget";
import { registry, McpTool } from "./registry";

export interface TavilySearchItem {
    title: string;
    url: string;
    content: string;
    score?: number;
    publishedAt?: string;
}

export interface TavilySearchOptions {
    maxResults?: number;
    searchDepth?: "basic" | "advanced";
    topic?: "general" | "news";
    days?: number;
    includeDomains?: string[];
    excludeDomains?: string[];
    includeAnswer?: boolean;
    includeImages?: boolean;
    includeRawContent?: boolean;
}

function normalizePublishedAt(raw: unknown): string | undefined {
    if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) return undefined;
    return new Date(parsed).toISOString();
}

/**
 * Perform a web search using the Tavily API.
 */
export async function performTavilySearchItems(
    query: string,
    opts: TavilySearchOptions = {}
): Promise<TavilySearchItem[]> {
    if (!config.TAVILY_API_KEY) {
        throw new Error("TAVILY_API_KEY is missing from configuration.");
    }

    const maxResults = Math.max(1, Math.min(12, Math.floor(opts.maxResults ?? 5)));
    const body: Record<string, unknown> = {
        api_key: config.TAVILY_API_KEY,
        query,
        search_depth: opts.searchDepth ?? "basic",
        include_answer: opts.includeAnswer ?? false,
        include_images: opts.includeImages ?? false,
        include_raw_content: opts.includeRawContent ?? false,
        max_results: maxResults,
    };

    if (opts.topic) body.topic = opts.topic;
    if (Number.isFinite(opts.days) && (opts.days as number) > 0) {
        body.days = Math.floor(opts.days as number);
    }
    if (Array.isArray(opts.includeDomains) && opts.includeDomains.length > 0) {
        body.include_domains = opts.includeDomains;
    }
    if (Array.isArray(opts.excludeDomains) && opts.excludeDomains.length > 0) {
        body.exclude_domains = opts.excludeDomains;
    }

    const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const suffix = detail ? ` (${detail.slice(0, 200)})` : "";
        throw new Error(`Tavily API responded with status: ${res.status}${suffix}`);
    }

    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    if (results.length === 0) {
        return [];
    }

    return results
        .map((item: any) => ({
            title: String(item?.title ?? "Untitled"),
            url: String(item?.url ?? ""),
            content: String(item?.content ?? ""),
            score: typeof item?.score === "number" ? item.score : undefined,
            publishedAt: normalizePublishedAt(
                item?.published_date ?? item?.publishedAt ?? item?.published_at ?? item?.date
            ),
        } satisfies TavilySearchItem))
        .filter((item: TavilySearchItem) => Boolean(item.title || item.url || item.content));
}

export async function performTavilyNewsSearch(
    query: string,
    maxResults: number = 5,
    days: number = 1
): Promise<TavilySearchItem[]> {
    try {
        return await performTavilySearchItems(query, {
            maxResults,
            topic: "news",
            days,
            searchDepth: "advanced",
        });
    } catch {
        return performTavilySearchItems(query, {
            maxResults,
            searchDepth: "advanced",
        });
    }
}

export async function performTavilySearch(query: string, maxResults: number = 5): Promise<string> {
    const items = await performTavilySearchItems(query, { maxResults });
    if (!items.length) {
        return "No relevant search results found.";
    }

    let report = `Web search results for "${query}":\n\n`;
    for (const item of items) {
        report += `[${item.title}](${item.url})\n${item.content}\n\n`;
    }

    return report.trim();
}

/**
 * Web Search Tool for Gemini
 */
const webSearchTool: McpTool = {
    name: "web_search",
    description: "Search the web for up-to-date information, news, or viral trends. Crucial for pulling live examples when writing viral tweets.",
    execute: async (args: { query: string; userId?: string | number }, executionCtx?: Record<string, any>) => {
        if (!args.query) return "Error: No search query provided.";

        // Enforce Tavily daily budget per Telegram user
        const rawUserId = (args as any).userId
            ?? (executionCtx as any)?.userId
            ?? (executionCtx as any)?.ctx?.from?.id;
        const telegramId = Number(rawUserId);
        if (!Number.isFinite(telegramId)) {
            return "Error: Missing user ID for Tavily budget tracking. Link your account and retry.";
        }

        const budget = await checkAndConsumeTavilyBudget(telegramId);
        if (!budget.allowed) {
            return `⏳ Tavily search paused: ${budget.reason}. Try again after the daily reset.`;
        }

        try {
            return await performTavilySearch(args.query, 6);
        } catch (err: any) {
            return `❌ Web search failed: ${err.message}`;
        }
    },
    geminiDeclaration: {
        name: "web_search",
        description: "Search the web for real-time information and viral trends.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                query: {
                    type: SchemaType.STRING,
                    description: "The search query. Be specific, e.g., 'recent trending news about AI agents'",
                },
                userId: {
                    type: SchemaType.STRING,
                    description: "Telegram user ID for budget tracking. Usually provided automatically by the system.",
                }
            },
            required: ["query"],
        },
    },
};

// Auto-register during import
registry.register(webSearchTool);
