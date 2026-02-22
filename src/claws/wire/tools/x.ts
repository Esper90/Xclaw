import { SchemaType } from "@google/generative-ai";
import { postTweet } from "../xService";
import { registry, McpTool } from "./registry";

/**
 * X (Twitter) Publishing Tool
 * Allows the AI to post a tweet once refined and approved by the user.
 */
const publishTweetTool: McpTool = {
    name: "publish_tweet",
    description: "Publish a tweet to X (Twitter). Use this ONLY when the user explicitly confirms they want to post a specific draft. Suggest a draft first and wait for approval.",
    execute: async (args: { text: string }) => {
        if (!args.text) {
            return "Error: No tweet text provided.";
        }
        try {
            const tweetId = await postTweet(args.text);
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
            },
            required: ["text"],
        },
    },
};

// Auto-register during import
registry.register(publishTweetTool);
