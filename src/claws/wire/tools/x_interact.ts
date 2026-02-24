import { SchemaType } from "@google/generative-ai";
import { quoteTweet, interactWithTweet } from "../xService";
import { registry, McpTool } from "./registry";
import { upsertMemory } from "../../archive/pinecone";

/**
 * Quote Tweet Tool
 */
const quoteTweetTool: McpTool = {
    name: "quote_tweet",
    description: "Quote Tweet another specific tweet adding your own thoughts on top. User approval is required first.",
    execute: async (args: { text: string, quoteTweetId: string, userId: string }) => {
        if (!args.text || !args.quoteTweetId || !args.userId) {
            return "Error: text, quoteTweetId, and userId are required.";
        }

        try {
            const tweetId = await quoteTweet(args.text, args.quoteTweetId, args.userId);

            // Record in memory
            await upsertMemory(args.userId, args.text, {
                source: "my_tweet",
                tweetId: tweetId,
                createdAt: new Date().toISOString(),
                engagement: "0"
            }, `${args.userId}-my_tweet-${tweetId}`);

            return `✅ Quote Tweet published! View on X: https://x.com/i/status/${tweetId}`;
        } catch (err: any) {
            return `❌ Failed to quote tweet: ${err.message}`;
        }
    },
    geminiDeclaration: {
        name: "quote_tweet",
        description: "Quote Tweet an existing X (Twitter) tweet. You MUST ask the user for confirmation first.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                text: { type: SchemaType.STRING, description: "Your commentary to add on top of the quote." },
                quoteTweetId: { type: SchemaType.STRING, description: "The ID of the original tweet being quoted." },
                userId: { type: SchemaType.STRING, description: "The Telegram user ID of the current user." }
            },
            required: ["text", "quoteTweetId", "userId"]
        }
    }
};

/**
 * Interact Tool (Like or Retweet)
 */
const interactWithTweetTool: McpTool = {
    name: "interact_with_tweet",
    description: "Like or Retweet a specific tweet. You can do this autonomously if requested.",
    execute: async (args: { tweetId: string, action: "like" | "retweet", userId: string }) => {
        if (!args.tweetId || !args.action || !args.userId) {
            return "Error: tweetId, action, and userId are required.";
        }

        try {
            await interactWithTweet(args.tweetId, args.action, args.userId);
            return `✅ Successfully performed ${args.action} on tweet ${args.tweetId}`;
        } catch (err: any) {
            return `❌ Failed to ${args.action} tweet: ${err.message}`;
        }
    },
    geminiDeclaration: {
        name: "interact_with_tweet",
        description: "Hit the 'Like' or 'Retweet' button on a specific X (Twitter) tweet. You can execute this autonomously without asking for approval if the user implies it.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                tweetId: { type: SchemaType.STRING, description: "The ID of the tweet to interact with." },
                action: { type: SchemaType.STRING, description: "The action to perform: 'like' or 'retweet'." },
                userId: { type: SchemaType.STRING, description: "The Telegram user ID of the current user." }
            },
            required: ["tweetId", "action", "userId"]
        }
    }
};

// Auto-register
registry.register(quoteTweetTool);
registry.register(interactWithTweetTool);
