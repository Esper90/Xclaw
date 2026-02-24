import { SchemaType } from "@google/generative-ai";
import { registry, McpTool } from "./registry";

/**
 * Tool to allow the AI to natively enter or exit thread-building mode.
 */
const toggleThreadModeTool: McpTool = {
    name: "toggle_thread_mode",
    description: "Enable or disable thread-building mode. When ON, subsequent user messages (text or voice) are accumulated into a draft buffer instead of being replied to individually. Use this when the user says they want to 'write a thread' or has 'more ideas' for a post. Once enough ideas are collected, the user (or you) can trigger the final compilation.",
    execute: async (args: { on: boolean }, { ctx }) => {
        if (!ctx) return "❌ Internal Error: Telegram context missing.";

        ctx.session.threadMode = args.on;
        if (args.on) {
            ctx.session.threadBuffer = [];
            return "✅ Thread Mode: ACTIVE. I am now accumulating your messages. Keep sending ideas, and tell me when you're ready to compile and post the thread.";
        } else {
            return "✅ Thread Mode: DEACTIVATED.";
        }
    },
    geminiDeclaration: {
        name: "toggle_thread_mode",
        description: "Enable or disable thread-building mode for accumulating multiple notes into a single thread.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                on: {
                    type: SchemaType.BOOLEAN,
                    description: "Set to true to start building a thread, false to stop."
                }
            },
            required: ["on"]
        }
    }
};

// Auto-register during import
registry.register(toggleThreadModeTool);
