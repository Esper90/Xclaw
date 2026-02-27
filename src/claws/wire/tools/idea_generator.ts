import { SchemaType } from "@google/generative-ai";
import { registry, McpTool } from "./registry";
import { checkAndConsumeTavilyBudget } from "../../sense/apiBudget";
import { performTavilySearch } from "./web_search";
import { getUserProfile, updateUserProfile } from "../../../db/profileStore";

function formatIdeas(raw: string, fallbackNiche: string, count: number): string[] {
    const lines = raw
        .split(/\r?\n/)
        .map((l) => l.replace(/^[\-•\d\.\)]+\s*/, "").trim())
        .filter(Boolean);
    const uniq = Array.from(new Set(lines));
    if (uniq.length > 0) return uniq.slice(0, count);
    return [
        `Weekly roundup: what changed in ${fallbackNiche} this week?`,
        `Behind-the-scenes: how I'm building for ${fallbackNiche}`,
        `Quick tip: a 3-step playbook for ${fallbackNiche} creators`,
        `Case study: a win (or failure) from last week`,
        `Hot take: what's overrated in ${fallbackNiche}`,
    ].slice(0, count);
}

const ideaGeneratorTool: McpTool = {
    name: "personalized_idea_generator",
    description: "Generate tailored content ideas using niche, memory, and light web signals.",
    execute: async (args: { niche?: string; count?: number; tone?: string; userId?: string | number }, executionCtx?: Record<string, unknown>) => {
        const niche = (args.niche || "your audience").trim();
        const count = Math.min(Math.max(Number(args.count) || 5, 3), 8);
        const tone = (args.tone || "default").trim();

        const rawUserId = (args as any).userId
            ?? (executionCtx as any)?.userId
            ?? (executionCtx as any)?.ctx?.from?.id;
        const telegramId = Number(rawUserId);
        if (!Number.isFinite(telegramId)) {
            return "Error: Missing user ID for idea generation. Link your account and retry.";
        }

        let ideas: string[] = [];
        let note = "";

        const budget = await checkAndConsumeTavilyBudget(telegramId);
        if (budget.allowed) {
            try {
                const raw = await performTavilySearch(`trending angles for ${niche} creators this week, ${count} concise bullets`, 5);
                ideas = formatIdeas(raw, niche, count);
            } catch (err: any) {
                note = `(search failed: ${err.message})`;
                ideas = formatIdeas("", niche, count);
            }
        } else {
            note = `(search skipped: ${budget.reason})`;
            ideas = formatIdeas("", niche, count);
        }

        try {
            const profile = await getUserProfile(telegramId);
            const newPrefs = { ...(profile.prefs || {}) } as Record<string, unknown>;
            newPrefs.contentIdeasCache = { niche, ideas, tone, ts: Date.now() };
            await updateUserProfile(telegramId, { prefs: newPrefs });
        } catch (err) {
            console.warn(`[idea-generator-tool] Failed to cache ideas for ${telegramId}:`, err);
        }

        const body = ideas.map((i, idx) => `${idx + 1}. ${i}`).join("\n");
        return [
            `💡 Ideas for ${niche}${note ? " " + note : ""}`.trim(),
            tone !== "default" ? `Tone: ${tone}` : "",
            "",
            body,
            "",
            "Buttons: Draft thread | Save for later",
        ].filter(Boolean).join("\n");
    },
    geminiDeclaration: {
        name: "personalized_idea_generator",
        description: "Generate tailored content ideas for the user's niche with outlines and draft buttons.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                niche: { type: SchemaType.STRING, description: "Audience or topic focus (e.g., AI agents, indie hacking)." },
                count: { type: SchemaType.NUMBER, description: "Number of ideas to generate (3-8)." },
                tone: { type: SchemaType.STRING, description: "Optional tone guidance (e.g., punchy, friendly)." },
                userId: { type: SchemaType.STRING, description: "Telegram user ID for budgets and prefs." },
            },
            required: ["niche"],
        },
    },
};

registry.register(ideaGeneratorTool);
