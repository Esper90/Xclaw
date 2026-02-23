import { SchemaType } from "@google/generative-ai";
import { registry, McpTool } from "./registry";
import { getUser, upsertUser } from "../../../db/userStore";

export const updateUserSettingsTool: McpTool = {
    name: "update_user_settings",
    description: "Update the user's persistent settings, such as their timezone or notification preferences.",
    execute: async (args: { timezone?: string }, context?: Record<string, any>) => {
        if (!context?.userId) {
            return "❌ Error: userId not injected in execution context.";
        }

        try {
            const userId = Number(context.userId);
            const user = await getUser(userId);

            if (!user) {
                return "❌ Error: User not found in database. Please run /start and connect your X account first.";
            }

            if (args.timezone) {
                user.timezone = args.timezone;
            }

            await upsertUser(user);
            return `✅ Success: Settings updated. Timezone is now set to "${user.timezone}".`;
        } catch (err: any) {
            return `❌ Failed to update settings: ${err.message}`;
        }
    },
    geminiDeclaration: {
        name: "update_user_settings",
        description: "Save or update user-specific configuration like their local timezone.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                timezone: {
                    type: SchemaType.STRING,
                    description: "The user's local timezone (e.g. 'PST', 'Europe/London', 'America/New_York').",
                },
            },
        },
    },
};

// Auto-register during import
registry.register(updateUserSettingsTool);
