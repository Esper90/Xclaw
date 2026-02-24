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
    execute: async (args: { text: string, quoteTweetId: string, userId: string }, context?: any) => {
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

            const ctx: any = context?.ctx;
            if (ctx) {
                await ctx.reply(`✅ The Quote Tweet is live! You have a 60-second grace period to undo it.\n\nhttps://x.com/i/status/${tweetId}`, {
                    reply_markup: {
                        inline_keyboard: [[{ text: "🗑️ Undo Post", callback_data: `delete_tweet:${tweetId}` }]]
                    }
                });
            }

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
    description: "Like or Retweet one or multiple specific tweets. You can do this autonomously if requested (e.g., 'Like all these mentions').",
    execute: async (args: { tweetIds: string[], action: "like" | "retweet", userId: string }) => {
        if (!args.tweetIds || !Array.isArray(args.tweetIds) || args.tweetIds.length === 0 || !args.action || !args.userId) {
            return "Error: tweetIds (array), action, and userId are required.";
        }

        // Cap at 20 max to prevent aggressive rate limiting
        const idsToProcess = args.tweetIds.slice(0, 20);
        let successCount = 0;
        let errors = [];

        try {
            for (const tweetId of idsToProcess) {
                try {
                    await interactWithTweet(tweetId, args.action, args.userId);
                    successCount++;
                    // Delay slightly to respect rate limits
                    await new Promise(r => setTimeout(r, 1000));
                } catch (e: any) {
                    errors.push(`ID ${tweetId}: ${e.message}`);
                }
            }

            let message = `✅ Successfully performed ${args.action} on ${successCount} out of ${idsToProcess.length} tweets.`;
            if (errors.length > 0) {
                message += `\n❌ Errors encountered on ${errors.length} tweets. First error: ${errors[0]}`;
            }
            if (args.tweetIds.length > 20) {
                message += `\n⚠️ Note: The list was capped at 20 tweets to respect API rate limits. The rest were ignored.`;
            }

            return message;
        } catch (err: any) {
            return `❌ Fatal error during ${args.action} execution: ${err.message}`;
        }
    },
    geminiDeclaration: {
        name: "interact_with_tweet",
        description: "Hit the 'Like' or 'Retweet' button on one or multiple X (Twitter) tweets. You can execute this autonomously without asking for approval if the user implies it.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                tweetIds: {
                    type: SchemaType.ARRAY,
                    items: { type: SchemaType.STRING },
                    description: "Array of tweet IDs to interact with (max 20)."
                },
                action: { type: SchemaType.STRING, description: "The action to perform: 'like' or 'retweet'." },
                userId: { type: SchemaType.STRING, description: "The Telegram user ID of the current user." }
            },
            required: ["tweetIds", "action", "userId"]
        }
    }
};

// Auto-register
registry.register(quoteTweetTool);
registry.register(interactWithTweetTool);
