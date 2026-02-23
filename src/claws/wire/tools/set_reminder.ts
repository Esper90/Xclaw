import { SchemaType } from "@google/generative-ai";
import { registry, McpTool } from "./registry";
import { createReminder } from "../../../db/reminders";

export const setReminderTool: McpTool = {
    name: "set_reminder",
    description: "Set a future reminder for the user. When the specified time is reached, the bot will automatically ping them with the text.",
    execute: async (args: { text: string; isoDateTime: string }, context?: Record<string, any>) => {
        if (!context?.userId) {
            return "❌ Error: userId not injected in execution context. Cannot set reminder.";
        }
        if (!args.text || !args.isoDateTime) {
            return "❌ Error: Both text and isoDateTime are required fields.";
        }

        try {
            // Validate date parsing
            const date = new Date(args.isoDateTime);
            if (isNaN(date.getTime())) {
                return `❌ Error: Invalid ISO 8601 date format provided: ${args.isoDateTime}`;
            }

            // Ensure the time is in the future
            if (date.getTime() <= Date.now()) {
                return `❌ Error: Cannot set a reminder in the past. Current server time is ${new Date().toISOString()}`;
            }

            const reminder = await createReminder(Number(context.userId), args.text, date.toISOString());

            return `✅ Success: Reminder set for ${date.toISOString()} (UTC).`;
        } catch (err: any) {
            return `❌ Failed to save reminder: ${err.message}`;
        }
    },
    geminiDeclaration: {
        name: "set_reminder",
        description: "Set a reliable, persistent alert to ping the user via Telegram at a specific future time. This is the DEFAULT tool for all 'remind me' or 'ping me later' requests.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                text: {
                    type: SchemaType.STRING,
                    description: "The short message/content to remind the user about.",
                },
                isoDateTime: {
                    type: SchemaType.STRING,
                    description: "The exact future date and time to trigger this reminder, formatted as a strict ISO 8601 string (e.g. '2024-06-15T10:30:00.000Z'). Important: You must calculate this duration starting *from the user's provided local current time*.",
                }
            },
            required: ["text", "isoDateTime"],
        },
    },
};

// Auto-register during import
registry.register(setReminderTool);
