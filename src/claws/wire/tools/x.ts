import { SchemaType } from "@google/generative-ai";
import { postTweet, uploadTelegramMediaToX } from "../xService";
import { registry, McpTool } from "./registry";
import { upsertMemory } from "../../archive/pinecone";

/**
 * X (Twitter) Publishing Tool
 * Allows the AI to post a tweet once refined and approved by the user, optionally with media.
 */
const publishTweetTool: McpTool = {
    name: "publish_tweet",
    description: "Publish a tweet to X (Twitter). Use this ONLY when the user explicitly confirms they want to post a specific draft. Suggest a draft first and wait for approval. Can optionally attach an old photo if a mediaFileId is provided.",
    execute: async (args: { text: string, userId: string, mediaFileId?: string }) => {
        if (!args.text) return "Error: No tweet text provided.";
        if (!args.userId) return "Error: No userId provided in context.";

        try {
            let mediaIds: string[] | undefined;
            if (args.mediaFileId) {
                console.log(`[publish_tweet] Tool triggered with mediaFileId: ${args.mediaFileId}`);
                const mediaId = await uploadTelegramMediaToX(args.mediaFileId, args.userId);
                mediaIds = [mediaId];
            }

            const tweetId = await postTweet(args.text, args.userId, undefined, mediaIds);

            // Track this published tweet into the user's RAG for the Viral Style Engine
            if (tweetId) {
                await upsertMemory(args.userId, args.text, {
                    source: "my_tweet",
                    tweetId: tweetId,
                    createdAt: new Date().toISOString(),
                    engagement: "0"
                }, `${args.userId}-my_tweet-${tweetId}`);
            }

            return `✅ Tweet published successfully! ID: ${tweetId}`;
        } catch (err: any) {
            return `❌ Failed to publish tweet: ${err.message}`;
        }
    },
    geminiDeclaration: {
        name: "publish_tweet",
        description: "Publish a tweet to X (Twitter). User approval is required before calling this.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                text: {
                    type: SchemaType.STRING,
                    description: "The full content of the tweet to post.",
                },
                userId: {
                    type: SchemaType.STRING,
                    description: "The Telegram user ID of the current user. Echo this exactly.",
                },
                mediaFileId: {
                    type: SchemaType.STRING,
                    description: "Optional: The Telegram `file_id` of an image found via search_memory to attach to the tweet.",
                }
            },
            required: ["text", "userId"],
        },
    },
};

// Auto-register during import
registry.register(publishTweetTool);
