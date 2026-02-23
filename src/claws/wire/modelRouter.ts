import { config } from "../../config";
import { generateReply } from "./gemini";
import type { Content, FunctionDeclarationsTool } from "@google/generative-ai";
import type { GeminiReply } from "./gemini";

/**
 * Model router — reads AI_PROVIDER from config and dispatches accordingly.
 * To add a new provider: implement the same `generateReply` interface in a
 * separate adapter file and add a new case here.
 */
export async function routeToModel(
    systemPrompt: string,
    history: Content[],
    userMessage: string,
    tools?: FunctionDeclarationsTool[],
    dispatchTool?: (name: string, args: Record<string, unknown>, context?: Record<string, unknown>) => Promise<string>,
    context?: Record<string, unknown>
): Promise<GeminiReply> {
    switch (config.AI_PROVIDER) {
        case "gemini":
            return generateReply(systemPrompt, history, userMessage, tools, dispatchTool, context);
        default:
            throw new Error(`Unknown AI_PROVIDER: ${config.AI_PROVIDER}`);
    }
}
