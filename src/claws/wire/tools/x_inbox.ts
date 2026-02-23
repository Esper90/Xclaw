import { SchemaType } from "@google/generative-ai";
import { fetchDMs, fetchMentions, searchDMs, searchMentionsByContext } from "../xButler";
import { registry, McpTool } from "./registry";
import type { BotContext } from "../../connect/bot";
import type { PendingDM, PendingMention } from "../../connect/session";

const LABELS = "ABCDEFGHIJKLMNOP".split("");

/**
 * X Inbox Tools: Check Mentions
 */
const checkMentionsTool: McpTool = {
    name: "check_mentions",
    description: "Fetch recent X (Twitter) mentions for the user. Call this when the user asks what's happening on their timeline or if anyone replied to them.",
    execute: async (args: { userId: string, limit?: number }, executionCtx?: Record<string, any>) => {
        if (!args.userId) return "Error: No userId provided.";
        try {
            const mentions = await fetchMentions(args.userId, args.limit || 10);
            if (mentions.length === 0) return "No new mentions found (or none scored high enough).";

            if (executionCtx?.ctx) {
                const ctx = executionCtx.ctx as BotContext;
                ctx.session.pendingMentions = mentions.map((m, i) => ({
                    label: LABELS[i] ?? String(i + 1),
                    id: m.id,
                    authorId: m.authorId,
                    authorUsername: m.authorUsername,
                    text: m.text,
                    suggestedReply: m.suggestedReply,
                } satisfies PendingMention));
            }

            return JSON.stringify(mentions, null, 2);
        } catch (err: any) {
            return `❌ Failed to fetch mentions: ${err.message}`;
        }
    },
    geminiDeclaration: {
        name: "check_mentions",
        description: "Fetch recent X (Twitter) mentions for the user.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                userId: {
                    type: SchemaType.STRING,
                    description: "The Telegram user ID of the current user. Echo this exactly as provided in the system prompt.",
                },
                limit: {
                    type: SchemaType.INTEGER,
                    description: "Optional number of mentions to fetch. Defaults to 10.",
                }
            },
            required: ["userId"],
        },
    },
};

/**
 * X Inbox Tools: Check DMs
 */
const checkDmsTool: McpTool = {
    name: "check_dms",
    description: "Fetch recent X (Twitter) Direct Messages (DMs) for the user. Call this when the user asks 'check my DMs' or 'any new messages on X?'.",
    execute: async (args: { userId: string, limit?: number }, executionCtx?: Record<string, any>) => {
        if (!args.userId) return "Error: No userId provided.";
        try {
            const dms = await fetchDMs(args.userId, args.limit || 5);
            if (dms.length === 0) return "No DMs found in the inbox.";

            if (executionCtx?.ctx) {
                const ctx = executionCtx.ctx as BotContext;
                ctx.session.pendingDMs = dms.map((dm, i) => ({
                    label: LABELS[i] ?? String(i + 1),
                    id: dm.id,
                    conversationId: dm.conversationId,
                    senderId: dm.senderId,
                    senderUsername: dm.senderUsername,
                    text: dm.text,
                    suggestedReply: dm.suggestedReply,
                } satisfies PendingDM));
            }

            return JSON.stringify(dms, null, 2);
        } catch (err: any) {
            return `❌ Failed to fetch DMs: ${err.message}`;
        }
    },
    geminiDeclaration: {
        name: "check_dms",
        description: "Fetch recent X (Twitter) DMs for the user.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                userId: {
                    type: SchemaType.STRING,
                    description: "The Telegram user ID of the current user. Echo this exactly as provided in the system prompt.",
                },
                limit: {
                    type: SchemaType.INTEGER,
                    description: "Optional number of DMs to fetch. Defaults to 5.",
                }
            },
            required: ["userId"],
        },
    },
};

/**
 * X Inbox Tools: Search Mentions
 */
const searchMentionsTool: McpTool = {
    name: "search_mentions",
    description: "Search the user's past X mentions by specific person, topic, or context. Call this when the user asks 'find the mention from Bob' or 'that reply about the partnership'.",
    execute: async (args: { userId: string, query: string, limit?: number }, executionCtx?: Record<string, any>) => {
        if (!args.userId) return "Error: No userId provided.";
        if (!args.query) return "Error: No query provided.";
        try {
            const mentions = await searchMentionsByContext(args.userId, args.query, args.limit || 5);
            if (mentions.length === 0) return `No past mentions found matching "${args.query}".`;

            if (executionCtx?.ctx) {
                const ctx = executionCtx.ctx as BotContext;
                ctx.session.pendingMentions = mentions.map((m, i) => ({
                    label: LABELS[i] ?? String(i + 1),
                    id: m.id,
                    authorId: m.authorId,
                    authorUsername: m.authorUsername,
                    text: m.text,
                    suggestedReply: m.suggestedReply,
                } satisfies PendingMention));
            }

            return JSON.stringify(mentions, null, 2);
        } catch (err: any) {
            return `❌ Failed to search mentions: ${err.message}`;
        }
    },
    geminiDeclaration: {
        name: "search_mentions",
        description: "Search the user's past X mentions by specific person, topic, or context.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                userId: {
                    type: SchemaType.STRING,
                    description: "The Telegram user ID of the current user. Echo this exactly.",
                },
                query: {
                    type: SchemaType.STRING,
                    description: "The name, topic, or description of the mention to find.",
                },
                limit: {
                    type: SchemaType.INTEGER,
                    description: "Optional number of results to return. Defaults to 5.",
                }
            },
            required: ["userId", "query"],
        },
    },
};

/**
 * X Inbox Tools: Search DMs
 */
const searchDmsTool: McpTool = {
    name: "search_dms",
    description: "Search the user's X DMs for a specific sender, topic, or content. Call this when the user asks 'find the DM from Sage' or 'bring up the messages about pricing'.",
    execute: async (args: { userId: string, query: string }, executionCtx?: Record<string, any>) => {
        if (!args.userId) return "Error: No userId provided.";
        if (!args.query) return "Error: No query provided.";
        try {
            const dms = await searchDMs(args.userId, args.query);
            if (dms.length === 0) return `No DMs found matching "${args.query}".`;

            if (executionCtx?.ctx) {
                const ctx = executionCtx.ctx as BotContext;
                ctx.session.pendingDMs = dms.map((dm, i) => ({
                    label: LABELS[i] ?? String(i + 1),
                    id: dm.id,
                    conversationId: dm.conversationId,
                    senderId: dm.senderId,
                    senderUsername: dm.senderUsername,
                    text: dm.text,
                    suggestedReply: dm.suggestedReply,
                } satisfies PendingDM));
            }

            return JSON.stringify(dms, null, 2);
        } catch (err: any) {
            return `❌ Failed to search DMs: ${err.message}`;
        }
    },
    geminiDeclaration: {
        name: "search_dms",
        description: "Search the user's X DMs for a specific sender, topic, or content.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                userId: {
                    type: SchemaType.STRING,
                    description: "The Telegram user ID of the current user. Echo this exactly.",
                },
                query: {
                    type: SchemaType.STRING,
                    description: "The name, handle, or topic to search for in DMs.",
                }
            },
            required: ["userId", "query"],
        },
    },
};

// Auto-register during import
registry.register(checkMentionsTool);
registry.register(checkDmsTool);
registry.register(searchMentionsTool);
registry.register(searchDmsTool);
