import { SchemaType } from "@google/generative-ai";
import { registry, McpTool } from "./registry";

/**
 * Tool to allow the AI to send a previously stored Telegram media file (photo, document, voice, video)
 * back to the user in the chat, using its file_id.
 */
const sendTelegramMediaTool: McpTool = {
    name: "send_telegram_media",
    description: "Send a photo, document, video, or voice note back to the Telegram chat. Use this when the user asks to 'see that photo again' or 'retrieve the file' and you can find the `fileId` in your memory search. You can also specify an optional caption.",
    execute: async (args: { fileId: string, type: "photo" | "document" | "video" | "voice", caption?: string }, context?: any) => {
        const ctx = context?.ctx;
        if (!ctx) return "❌ Internal Error: Telegram context missing.";
        if (!args.fileId) return "❌ Error: fileId is required.";

        try {
            switch (args.type) {
                case "photo":
                    await ctx.api.sendPhoto(ctx.chat.id, args.fileId, { caption: args.caption, parse_mode: "Markdown" });
                    break;
                case "document":
                    await ctx.api.sendDocument(ctx.chat.id, args.fileId, { caption: args.caption, parse_mode: "Markdown" });
                    break;
                case "video":
                    await ctx.api.sendVideo(ctx.chat.id, args.fileId, { caption: args.caption, parse_mode: "Markdown" });
                    break;
                case "voice":
                    await ctx.api.sendVoice(ctx.chat.id, args.fileId, { caption: args.caption, parse_mode: "Markdown" });
                    break;
                default:
                    // Fallback to sending as a document if type is unknown or omitted
                    await ctx.api.sendDocument(ctx.chat.id, args.fileId, { caption: args.caption, parse_mode: "Markdown" });
                    break;
            }
            return `✅ Media sent successfully to the chat.`;
        } catch (err: any) {
            console.error(`[send_telegram_media] Failed to send media:`, err);
            return `❌ Failed to send media to chat. The fileId might be invalid or expired. Error: ${err.message}`;
        }
    },
    geminiDeclaration: {
        name: "send_telegram_media",
        description: "Send a photo or file back to the user in Telegram. Use the `fileId` found in your memory search results.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                fileId: {
                    type: SchemaType.STRING,
                    description: "The unique Telegram file_id of the media to send."
                },
                type: {
                    type: SchemaType.STRING,
                    description: "The type of media: 'photo', 'document', 'video', or 'voice'. Default is 'photo'.",
                },
                caption: {
                    type: SchemaType.STRING,
                    description: "Optional text to send along with the media.",
                }
            },
            required: ["fileId", "type"]
        }
    }
};

// Auto-register during import
registry.register(sendTelegramMediaTool);
