import { registry, type McpTool } from "./registry";
import { createScheduledPost } from "../../../db/scheduledPosts";
import { getUserProfile } from "../../../db/profileStore";
import { SchemaType } from "@google/generative-ai";

function formatLocal(iso: string, tz?: string | null): string {
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz || "UTC",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    });
    return formatter.format(new Date(iso));
}

export const schedulePostTool: McpTool = {
    name: "schedule_post",
    description: "Schedules a tweet to be published to the user's connected X (Twitter) account at a specific date and time.",

    async execute(args: Record<string, unknown>, context?: Record<string, unknown>) {
        const telegramId = (context as any)?.telegramId
            ?? (context as any)?.userId
            ?? (context as any)?.ctx?.from?.id;

        if (!telegramId) {
            return "Error: telegramId is missing from context. Cannot schedule post.";
        }

        const { text, postAtIso } = args as { text: string; postAtIso: string };

        if (!text || !postAtIso) {
            return "Error: Both 'text' and 'postAtIso' are required to schedule a post.";
        }

        const scheduledTime = new Date(postAtIso);
        if (isNaN(scheduledTime.getTime())) {
            return `Error: '${postAtIso}' is not a valid ISO 8601 date string.`;
        }

        if (scheduledTime <= new Date()) {
            return `Error: The scheduled time must be in the future. Today is ${new Date().toISOString()}.`;
        }

        try {
            const profile = await getUserProfile(telegramId).catch(() => null);
            const tz = profile?.timezone;
            const post = await createScheduledPost(telegramId, text, scheduledTime.toISOString());
            const localStamp = formatLocal(post.post_at, tz);
            return `Success! Tweet scheduled for ${scheduledTime.toISOString()} UTC (local: ${localStamp}${tz ? " " + tz : ""}).\nDatabase ID: ${post.id}\nContent: "${text}"`;
        } catch (error: any) {
            return `Error scheduling post: ${error.message}`;
        }
    },

    geminiDeclaration: {
        name: "schedule_post",
        description: `Schedule a tweet to be published on X at a specific future date and time. Use this when the user says "schedule this to post tomorrow", "post this at 5pm", etc. Do NOT use this for immediate posts (use post_tweet for that). ALWAYS confirm with the user they are happy with the exact time before calling this tool.`,
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                text: {
                    type: SchemaType.STRING,
                    description: "The complete text content of the tweet to be scheduled. Max 280 chars.",
                },
                postAtIso: {
                    type: SchemaType.STRING,
                    description: "The exact future date and time to publish the tweet, formatted as an ISO 8601 string (e.g., '2026-02-26T17:00:00.000Z'). Make sure you calculate this correctly relative to the current time.",
                }
            },
            required: ["text", "postAtIso"],
        },
    },
};

registry.register(schedulePostTool);
