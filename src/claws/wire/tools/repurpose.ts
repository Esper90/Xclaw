import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { registry, type McpTool } from "./registry";
import { getUserXClient } from "../../db/getUserClient";
import { checkAndConsumeXBudget } from "../sense/apiBudget";
import { config } from "../../../config";

/**
 * Fetch the user's latest original X post to use as a repurposing source.
 * Requires OAuth1 creds from /setup.
 */
const latestXPostTool: McpTool = {
    name: "get_latest_x_post",
    description: "Fetch the user's most recent original X post (not a retweet or reply) to repurpose into other formats.",
    geminiDeclaration: {
        name: "get_latest_x_post",
        description: "Fetch the user's most recent original X post (no retweets or replies). Use before repurposing content.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                userId: {
                    type: SchemaType.STRING,
                    description: "Telegram user ID for selecting the correct X credentials.",
                },
                maxResults: {
                    type: SchemaType.INTEGER,
                    description: "Optional number of recent posts to scan (default 5).",
                },
            },
            required: ["userId"],
        },
    },
    execute: async (args): Promise<string> => {
        const { userId, maxResults } = args as { userId?: string | number; maxResults?: number };
        if (!userId) return "Error: No userId provided.";

        const telegramId = Number(userId);
        if (!Number.isFinite(telegramId)) return "Error: userId must be numeric.";

        const budget = await checkAndConsumeXBudget(telegramId);
        if (!budget.allowed) return `⏳ X fetch paused: ${budget.reason}.`;

        try {
            const client = await getUserXClient(userId);
            const me = await client.v2.me({ "user.fields": ["id", "username"] });
            const timeline = await client.v2.userTimeline(me.data.id, {
                max_results: Math.min(Math.max(maxResults ?? 5, 1), 20),
                exclude: ["replies", "retweets"],
                "tweet.fields": ["id", "text", "created_at"],
            } as any);

            const tweets = timeline.data?.data ?? [];
            if (tweets.length === 0) return "No original posts found to repurpose.";

            const latest = tweets[0];
            const preview = latest.text.length > 220 ? `${latest.text.slice(0, 220)}…` : latest.text;
            return `Latest X post (id=${latest.id}, ${latest.created_at ?? "unknown time"}):\n${preview}`;
        } catch (err: any) {
            return `❌ Failed to fetch latest post: ${err?.message ?? err}`;
        }
    },
};

registry.register(latestXPostTool);

const repurposeContentTool: McpTool = {
    name: "repurpose_content",
    description: "Repurpose a source post into LinkedIn, Telegram carousel bullets, newsletter blurb, and an X thread variant.",
    geminiDeclaration: {
        name: "repurpose_content",
        description: "Repurpose a source post into multiple channel-ready drafts (LinkedIn, Telegram carousel, newsletter, X thread).",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                sourceText: {
                    type: SchemaType.STRING,
                    description: "The original post text to repurpose. Required unless the model already fetched it via get_latest_x_post.",
                },
                audience: {
                    type: SchemaType.STRING,
                    description: "Optional target audience or tone guidance.",
                },
                callToAction: {
                    type: SchemaType.STRING,
                    description: "Optional CTA to weave into the outputs.",
                },
            },
            required: ["sourceText"],
        },
    },
    execute: async (args): Promise<string> => {
        const { sourceText, audience, callToAction } = args as {
            sourceText?: string;
            audience?: string;
            callToAction?: string;
        };

        if (!sourceText || sourceText.trim().length === 0) {
            return "Error: sourceText is required to repurpose.";
        }

        const ai = new GoogleGenerativeAI(config.GEMINI_API_KEY);
        const model = ai.getGenerativeModel({ model: config.GEMINI_MODEL });

        const prompt = [
            "Repurpose the following source post into channel-ready drafts.",
            audience ? `Audience/tone: ${audience}` : "",
            callToAction ? `CTA: ${callToAction}` : "",
            "",
            "Requirements:",
            "- Preserve the core idea and voice; tighten wording.",
            "- Keep LinkedIn concise (<=180 words) with a hook and light spacing.",
            "- Telegram carousel: 4-6 bullet cards, each punchy and standalone.",
            "- Newsletter blurb: 120-180 words, with a clear CTA at the end if provided.",
            "- X thread variant: 4-8 tweets, numbered, each <=260 chars, include CTA only in the final tweet.",
            "- Return clean markdown sections with clear labels.",
            "",
            "Source:",
            sourceText.trim(),
        ]
            .filter(Boolean)
            .join("\n");

        try {
            const result = await model.generateContent(prompt);
            return result.response.text().trim();
        } catch (err: any) {
            return `❌ Repurpose failed: ${err?.message ?? err}`;
        }
    },
};

registry.register(repurposeContentTool);
