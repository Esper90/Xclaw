import { SchemaType } from "@google/generative-ai";
import { queryMemory } from "../../archive/pinecone";
import { registry, McpTool } from "./registry";

/**
 * Semantic Memory Search Tool
 * Allows the AI to autonomously query Pinecone for past interactions, context, or media file_ids.
 */
const searchMemoryTool: McpTool = {
    name: "search_memory",
    description: "Search the user's long-term memory (Pinecone) for past conversations, facts, or descriptions of uploaded photos. Useful for finding context before replying to DMs/Mentions, or retrieving a 'fileId' to attach an old photo to a new tweet.",
    execute: async (args: { query: string, userId: string }) => {
        if (!args.query) return "Error: No query provided.";
        if (!args.userId) return "Error: No userId provided in context.";

        try {
            const results = await queryMemory(args.userId, args.query, 10);
            if (results.length === 0) {
                return `No memories found matching "${args.query}".`;
            }

            // Filter to reasonably relevant stuff
            const relevant = results.filter(r => r.score >= 0.70);
            if (relevant.length === 0) {
                return `Found some vaguely related memories, but nothing with a strong match for "${args.query}".`;
            }

            let msg = `Found ${relevant.length} relevant memories:\n\n`;
            for (const r of relevant) {
                const typeLabel = r.metadata.source || "Unknown";
                const fileIdStr = r.metadata.fileId ? ` | fileId: ${r.metadata.fileId}` : "";

                msg += `[${typeLabel}] (Match: ${(r.score * 100).toFixed(0)}%${fileIdStr})\n`;
                msg += `${r.text}\n\n`;
            }

            return msg.trim();
        } catch (err: any) {
            return `❌ Failed to search memory: ${err.message}`;
        }
    },
    geminiDeclaration: {
        name: "search_memory",
        description: "Search the user's long-term memory for past conversations or uploaded photos. Returns text and optionally a 'fileId' if it was a photo.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                query: {
                    type: SchemaType.STRING,
                    description: "The topic, person, or description to search for.",
                },
                // In a real system we'd inject this safely, but for the hackathon we'll ask Gemini to echo it.
                // We'll update the textHandler to pass it in the prompt.
                userId: {
                    type: SchemaType.STRING,
                    description: "The Telegram user ID of the current user. Echo this exactly as provided in the system prompt.",
                }
            },
            required: ["query", "userId"],
        },
    },
};

// Auto-register during import
registry.register(searchMemoryTool);
