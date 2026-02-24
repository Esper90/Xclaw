import { SchemaType } from "@google/generative-ai";
import { postButlerReply } from "../xButler";
import { registry, McpTool } from "./registry";

/**
 * X Reply Tools: Reply to Mention
 */
const replyToMentionTool: McpTool = {
    name: "reply_to_mention",
    description: "Send a reply to an X (Twitter) mention. Usually called after checking mentions.",
    execute: async (args: { userId: string, tweetId: string, text: string }) => {
        if (!args.userId || !args.tweetId || !args.text) {
            return "Error: userId, tweetId, and text are all required.";
        }
        try {
            const result = await postButlerReply(args.userId, args.tweetId, args.text, false);
            if (!result.success) return `❌ Failed to reply: ${result.error}`;
            return `✅ Reply to mention posted successfully. View on X: https://x.com/i/status/${result.resultId}`;
        } catch (err: any) {
            return `❌ Exception while replying: ${err.message}`;
        }
    },
    geminiDeclaration: {
        name: "reply_to_mention",
        description: "Send a reply to a specific X (Twitter) mention.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                userId: {
                    type: SchemaType.STRING,
                    description: "The Telegram user ID of the current user. Echo this exactly as provided in the system prompt.",
                },
                tweetId: {
                    type: SchemaType.STRING,
                    description: "The ID of the tweet/mention being replied to.",
                },
                text: {
                    type: SchemaType.STRING,
                    description: "The content of the reply.",
                }
            },
            required: ["userId", "tweetId", "text"],
        },
    },
};

/**
 * X Reply Tools: Reply to DM
 */
const replyToDmTool: McpTool = {
    name: "reply_to_dm",
    description: "Send a reply to an X (Twitter) Direct Message. Usually called after checking DMs.",
    execute: async (args: { userId: string, dmId: string, text: string, conversationId: string }) => {
        if (!args.userId || !args.dmId || !args.text || !args.conversationId) {
            return "Error: userId, dmId, text, and conversationId are all required.";
        }
        try {
            const result = await postButlerReply(args.userId, args.dmId, args.text, true, args.conversationId);
            if (!result.success) return `❌ Failed to send DM: ${result.error}`;
            return "✅ DM sent successfully.";
        } catch (err: any) {
            return `❌ Exception while sending DM: ${err.message}`;
        }
    },
    geminiDeclaration: {
        name: "reply_to_dm",
        description: "Send a reply to an X (Twitter) Direct Message.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                userId: {
                    type: SchemaType.STRING,
                    description: "The Telegram user ID of the current user. Echo this exactly.",
                },
                dmId: {
                    type: SchemaType.STRING,
                    description: "The ID of the DM being replied to.",
                },
                conversationId: {
                    type: SchemaType.STRING,
                    description: "The conversation ID of the DM thread.",
                },
                text: {
                    type: SchemaType.STRING,
                    description: "The content of the reply.",
                }
            },
            required: ["userId", "dmId", "conversationId", "text"],
        },
    },
};

// Auto-register during import
registry.register(replyToMentionTool);
registry.register(replyToDmTool);
