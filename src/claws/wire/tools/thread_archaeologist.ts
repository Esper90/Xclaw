import { SchemaType } from "@google/generative-ai";
import { registry, type McpTool } from "./registry";
import { getUserXClient } from "../../db/getUserClient";
import { checkAndConsumeXBudget } from "../sense/apiBudget";

function extractTweetId(input: string): string | null {
    if (!input) return null;
    const urlMatch = input.match(/status\/(\d+)/);
    if (urlMatch) return urlMatch[1];
    const idMatch = input.match(/(\d{8,})/);
    return idMatch ? idMatch[1] : null;
}

async function fetchThreadTweets(client: any, tweetId: string): Promise<Array<{ id: string; text: string; created_at?: string }>> {
    // 1) Get the tweet to discover conversation_id and author
    const base = await client.v2.singleTweet(tweetId, {
        expansions: ["author_id"],
        "tweet.fields": ["conversation_id", "author_id", "created_at", "text"],
    } as any);
    const conversationId = base.data?.conversation_id;
    const authorId = base.data?.author_id;
    if (!conversationId || !authorId) return base.data ? [base.data] : [];

    // 2) Search the conversation for all tweets from the same author
    const search = await client.v2.search(`conversation_id:${conversationId} from:${authorId}`, {
        max_results: 50,
        "tweet.fields": ["id", "text", "created_at"],
    } as any);

    const tweets = search.data?.data ?? [];
    if (!tweets.length && base.data) return [base.data];

    // Include the base tweet to ensure it's present
    const combined = [...tweets, base.data].filter(Boolean) as Array<{ id: string; text: string; created_at?: string }>;
    // Deduplicate by id
    const byId = new Map<string, { id: string; text: string; created_at?: string }>();
    for (const t of combined) byId.set(t.id, t);

    // Sort by creation time ascending if available, else by id
    const sorted = Array.from(byId.values()).sort((a, b) => {
        if (a.created_at && b.created_at) return a.created_at.localeCompare(b.created_at);
        return a.id.localeCompare(b.id);
    });
    return sorted;
}

const threadArchaeologistTool: McpTool = {
    name: "thread_archaeologist",
    description: "Fetch and summarize a tweet thread given a tweet URL or ID. Requires user X creds from /setup.",
    geminiDeclaration: {
        name: "thread_archaeologist",
        description: "Retrieve a full tweet thread (conversation) from a URL or tweet ID, then summarize it.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                userId: {
                    type: SchemaType.STRING,
                    description: "Telegram user ID whose X creds should be used.",
                },
                tweetUrlOrId: {
                    type: SchemaType.STRING,
                    description: "Tweet URL or numeric ID to start from (any tweet in the thread).",
                },
            },
            required: ["userId", "tweetUrlOrId"],
        },
    },
    execute: async (args): Promise<string> => {
        const { userId, tweetUrlOrId } = args as { userId?: string | number; tweetUrlOrId?: string };
        if (!userId) return "Error: userId is required.";
        if (!tweetUrlOrId) return "Error: tweetUrlOrId is required.";

        const telegramId = Number(userId);
        if (!Number.isFinite(telegramId)) return "Error: userId must be numeric.";

        const budget = await checkAndConsumeXBudget(telegramId);
        if (!budget.allowed) return `⏳ X fetch paused: ${budget.reason}.`;

        const tweetId = extractTweetId(tweetUrlOrId);
        if (!tweetId) return "Error: could not parse a tweet ID from the input.";

        try {
            const client = await getUserXClient(userId);
            const tweets = await fetchThreadTweets(client, tweetId);
            if (!tweets.length) return "No tweets found for that thread.";

            const lines = tweets.map((t, i) => {
                const preview = t.text.length > 240 ? `${t.text.slice(0, 240)}…` : t.text;
                return `${i + 1}. ${preview}`;
            });

            return [
                `Thread length: ${tweets.length} tweets`,
                ...lines,
            ].join("\n");
        } catch (err: any) {
            return `❌ Failed to fetch thread: ${err?.message ?? err}`;
        }
    },
};

registry.register(threadArchaeologistTool);
