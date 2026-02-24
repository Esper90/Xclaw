import { SchemaType } from "@google/generative-ai";
import { deleteTweet } from "../xService";
import { forgetMemory } from "../../archive/pinecone";
import { registry, McpTool } from "./registry";

/**
 * Delete Tweet Tool
 */
const deleteTweetTool: McpTool = {
    name: "delete_tweet",
    description: "Delete a specific tweet from X (Twitter) that you previously posted. Also removes it from local memory.",
    execute: async (args: { tweetId: string, userId: string }) => {
        if (!args.tweetId || !args.userId) {
            return "Error: tweetId and userId are required.";
        }

        try {
            await deleteTweet(args.tweetId, args.userId);

            // Try to remove it from memory if we added it
            try {
                await forgetMemory(args.userId, `[System: Direct ID deletion]`, `${args.userId}-my_tweet-${args.tweetId}`);
            } catch (ignore) {
                // It might not be in memory, that's fine
            }

            return `✅ Tweet ${args.tweetId} was successfully deleted from X.`;
        } catch (err: any) {
            return `❌ Failed to delete tweet: ${err.message}`;
        }
    },
    geminiDeclaration: {
        name: "delete_tweet",
        description: "Delete a tweet from X (Twitter). Use this if the user says 'Oops, delete that last tweet' or 'Undo that post'.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                tweetId: { type: SchemaType.STRING, description: "The ID of the tweet to delete." },
                userId: { type: SchemaType.STRING, description: "The Telegram user ID." }
            },
            required: ["tweetId", "userId"]
        }
    }
};

// Auto-register
registry.register(deleteTweetTool);
