import { config } from "../../config";
import { generateReply } from "./gemini";
import { generateGrokReply } from "./grok";
import type { Content, FunctionDeclarationsTool } from "@google/generative-ai";
import type { GeminiReply } from "./gemini";
import { getUser } from "../../db/userStore";

/**
 * Model router — reads user preference from DB and dispatches accordingly.
 * Defaults to Grok if not specified.
 */
export async function routeToModel(
    systemPrompt: string,
    history: Content[],
    userMessage: string,
    tools?: FunctionDeclarationsTool[],
    dispatchTool?: (name: string, args: Record<string, unknown>, context?: Record<string, unknown>) => Promise<string>,
    context?: Record<string, unknown>
): Promise<GeminiReply> {

    let preferredAi = "grok";

    // Attempt to lookup the user's preference if we have a Telegram ID in context
    if (context?.userId) {
        try {
            const user = await getUser(Number(context.userId));
            if (user?.preferred_ai) {
                preferredAi = user.preferred_ai;
            }
        } catch (err) {
            console.warn(`[modelRouter] Failed to lookup user preference for ${context.userId}:`, err);
        }
    }

    console.log(`[modelRouter] Routing to: ${preferredAi}`);

    switch (preferredAi) {
        case "gemini":
            return generateReply(systemPrompt, history, userMessage, tools, dispatchTool, context);
        case "grok":
            return generateGrokReply(systemPrompt, history, userMessage, tools, dispatchTool, context);
        default:
            return generateGrokReply(systemPrompt, history, userMessage, tools, dispatchTool, context);
    }
}
