import { SchemaType } from "@google/generative-ai";
import { registry, McpTool } from "./registry";
import { checkAndConsumeTavilyBudget } from "../../sense/apiBudget";
import { performTavilySearch } from "./web_search";
import { getUserProfile, updateUserProfile } from "../../../db/profileStore";

function formatNews(raw: string, maxItems: number): string[] {
    return raw
        .split(/\r?\n/)
        .map((l) => l.replace(/^[\-•\d\.\)]+\s*/, "").trim())
        .filter(Boolean)
        .slice(0, maxItems);
}

const newsCuratorTool: McpTool = {
    name: "custom_news_curator",
    description: "Curate a short digest from user-defined topics/feeds with one Tavily pull.",
    execute: async (args: { topics?: string[]; maxItems?: number; userId?: string | number }, executionCtx?: Record<string, unknown>) => {
        const topics = Array.isArray(args.topics) && args.topics.length > 0 ? args.topics : [];
        const maxItems = Math.min(Math.max(Number(args.maxItems) || 3, 2), 6);

        const rawUserId = (args as any).userId
            ?? (executionCtx as any)?.userId
            ?? (executionCtx as any)?.ctx?.from?.id;
        const telegramId = Number(rawUserId);
        if (!Number.isFinite(telegramId)) {
            return "Error: Missing user ID for news curation.";
        }

        const profile = await getUserProfile(telegramId);
        const savedTopics = Array.isArray((profile.prefs as any)?.newsTopics) ? (profile.prefs as any).newsTopics : [];
        const finalTopics = topics.length ? topics : savedTopics;
        if (!finalTopics.length) {
            return "No topics configured. Set topics in settings or pass topics: ['ai agents', 'indie hacking'].";
        }

        let bullets: string[] = [];
        let note = "";

        const budget = await checkAndConsumeTavilyBudget(telegramId);
        if (budget.allowed) {
            try {
                const query = `top news for ${finalTopics.join(", ")} today, ${maxItems} concise bullets with sources`;
                const raw = await performTavilySearch(query, maxItems + 1);
                bullets = formatNews(raw, maxItems);
            } catch (err: any) {
                note = `(search failed: ${err.message})`;
            }
        } else {
            note = `(search skipped: ${budget.reason})`;
        }

        if (!bullets.length) {
            const cached = (profile.prefs as any)?.newsDigest?.bullets as string[] | undefined;
            bullets = cached?.slice(0, maxItems) ?? finalTopics.slice(0, maxItems).map((t: string) => `Track: ${t}`);
        }

        try {
            const newPrefs = { ...(profile.prefs || {}) } as Record<string, unknown>;
            (newPrefs as any).newsTopics = finalTopics;
            (newPrefs as any).newsDigest = { topics: finalTopics, bullets, ts: Date.now() };
            await updateUserProfile(telegramId, { prefs: newPrefs });
        } catch (err) {
            console.warn(`[news-curator-tool] Failed to cache digest for ${telegramId}:`, err);
        }

        const message = [
            "📰 Custom News Digest",
            `Topics: ${finalTopics.join(", ")}${note ? " " + note : ""}`.trim(),
            "",
            bullets.map((b, i) => `${i + 1}. ${b}`).join("\n"),
            "",
            "Buttons: Refresh | Dismiss",
        ].filter(Boolean).join("\n");

        return message;
    },
    geminiDeclaration: {
        name: "custom_news_curator",
        description: "Generate a personalized news digest for the user's saved topics.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                topics: { type: SchemaType.ARRAY, description: "List of topics or feeds to prioritize.", items: { type: SchemaType.STRING } },
                maxItems: { type: SchemaType.NUMBER, description: "How many bullets to return (2-6)." },
                userId: { type: SchemaType.STRING, description: "Telegram user ID for budgets and prefs." },
            },
            required: [],
        },
    },
};

registry.register(newsCuratorTool);
