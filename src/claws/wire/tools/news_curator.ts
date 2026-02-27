import { SchemaType } from "@google/generative-ai";
import { registry, McpTool } from "./registry";
import { checkAndConsumeTavilyBudget } from "../../sense/apiBudget";
import { fetchCuratedNewsDigest } from "../../sense/newsDigest";
import { getUserProfile, updateUserProfile } from "../../../db/profileStore";
import { getLocalDayKey } from "../../sense/time";

const DAY_MS = 24 * 60 * 60 * 1000;

type SavedDigest = {
    bullets?: string[];
    ts?: number;
    dayKey?: string;
};

function isFreshCache(digest: SavedDigest | undefined, timezone: string | null | undefined): boolean {
    if (!digest?.bullets?.length || typeof digest.ts !== "number") return false;
    if (Date.now() - digest.ts > DAY_MS) return false;
    const cacheDayKey = digest.dayKey ?? getLocalDayKey(timezone, digest.ts);
    return cacheDayKey === getLocalDayKey(timezone);
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

        const digest = (profile.prefs as any)?.newsDigest as SavedDigest | undefined;
        const localDayKey = getLocalDayKey(profile.timezone);
        let bullets: string[] = [];
        let note = "";

        const budget = await checkAndConsumeTavilyBudget(telegramId);
        if (budget.allowed) {
            try {
                const live = await fetchCuratedNewsDigest(finalTopics, {
                    maxItems,
                    timezone: profile.timezone,
                    includeX: true,
                });
                bullets = live.bullets;
                note = `(fresh today: ${live.sameDayCount}/${Math.max(live.bullets.length, 1)}${live.hasXSource ? ", x pulse included" : ""})`;
            } catch (err: any) {
                note = `(search failed: ${err.message})`;
            }
        } else {
            note = `(search skipped: ${budget.reason})`;
        }

        if (!bullets.length) {
            if (isFreshCache(digest, profile.timezone)) {
                bullets = (digest!.bullets as string[]).slice(0, maxItems);
                if (!note) note = "(using fresh cache)";
            } else {
                bullets = finalTopics.slice(0, maxItems).map((t: string) => `Track: ${t}`);
                note = note || "(no fresh headlines yet)";
            }
        }

        try {
            const newPrefs = { ...(profile.prefs || {}) } as Record<string, unknown>;
            (newPrefs as any).newsTopics = finalTopics;
            (newPrefs as any).newsDigest = { topics: finalTopics, bullets, ts: Date.now(), dayKey: localDayKey };
            await updateUserProfile(telegramId, { prefs: newPrefs });
        } catch (err) {
            console.warn(`[news-curator-tool] Failed to cache digest for ${telegramId}:`, err);
        }

        const message = [
            "News: Custom Digest",
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
