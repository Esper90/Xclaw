import OpenAI from "openai";
import { config } from "../../config";
import type { Content, FunctionDeclarationsTool } from "@google/generative-ai";
import type { GeminiReply } from "./gemini";

const openai = new OpenAI({
    apiKey: config.GROK_API_KEY,
    baseURL: "https://api.x.ai/v1",
});

/**
 * Translates Gemini's multi-part Content[] array into OpenAI's Chat[] array.
 * Note: Grok does not natively support base64 images within the standard v1/chat/completions endpoint
 * unless using their specialized vision model, but since Xclaw uses a separate Pinecone 
 * embedding pipeline for photos, we only need to map text.
 */
function translateHistory(history: Content[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    return history.map((h) => {
        const role = h.role === "user" ? "user" : "assistant";
        const content = h.parts.map(p => p.text).join("");
        return { role, content };
    });
}

/**
 * Translates Gemini's FunctionDeclarationsTool[] into OpenAI's tools[] format.
 */
export function translateTools(geminiTools?: FunctionDeclarationsTool[]): OpenAI.Chat.ChatCompletionTool[] | undefined {
    if (!geminiTools || geminiTools.length === 0) return undefined;

    const allDeclarations = geminiTools.flatMap(t => t.functionDeclarations || []);
    if (allDeclarations.length === 0) return undefined;

    return allDeclarations.map(decl => ({
        type: "function",
        function: {
            name: decl.name,
            // Cast to any to bypass strict internal typing differences
            parameters: decl.parameters as any
        }
    }));
}

/**
 * Generate a reply from Grok using the OpenAI API spec.
 * Mirrors the `gemini.ts` interface precisely.
 */
export async function generateGrokReply(
    systemPrompt: string,
    history: Content[],
    userMessage: string,
    tools?: FunctionDeclarationsTool[],
    dispatchTool?: (name: string, args: Record<string, unknown>, context?: Record<string, unknown>) => Promise<string>,
    context?: Record<string, unknown>,
    maxToolTurns: number = 10
): Promise<GeminiReply> {

    // Build initial message array
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
        ...translateHistory(history),
        { role: "user", content: userMessage }
    ];

    const openaiTools = translateTools(tools);

    let turns = 0;
    let previousToolCallIds = "";

    while (turns < maxToolTurns) {
        turns++;

        const response = await openai.chat.completions.create({
            model: config.GROK_MODEL,
            messages: messages,
            ...(openaiTools ? { tools: openaiTools } : {}),
            // Optional: force Grok to execute tools if you need to, but auto is standard
            tool_choice: "auto",
        });

        const choice = response.choices[0];
        const message = choice.message;

        // Push the assistant's message (which includes the tool calls) to the history
        // This is critical for the OpenAI API protocol
        messages.push(message as OpenAI.Chat.ChatCompletionMessageParam);

        // If no tool calls, we're done
        if (!message.tool_calls || message.tool_calls.length === 0) {
            return { text: message.content || "" };
        }

        const currentToolCallIds = JSON.stringify(message.tool_calls.map((tc: any) => tc.id));
        if (currentToolCallIds === previousToolCallIds) {
            console.warn(`[grok] Tool loop detected! Aborting.`);
            return { text: message.content || "(System Error: I encountered a persistent error while using tools and automatically halted to prevent a timeout.)" };
        }
        previousToolCallIds = currentToolCallIds;

        console.log(`[grok] Turn ${turns}/${maxToolTurns} | Tools: ${message.tool_calls.map((tc: any) => tc.function.name).join(", ")}`);

        if (!dispatchTool) {
            console.warn(`[grok] Model requested ${message.tool_calls.length} tools but no dispatcher provided.`);
            return { text: message.content || "(Error: Tool calls requested but not supported)" };
        }

        // Execute all requested tools in parallel for this turn
        const toolResponses = await Promise.all(
            message.tool_calls.map(async (toolCall) => {
                const tc = toolCall as any;
                let args = {};
                try {
                    args = JSON.parse(tc.function.arguments);
                } catch (e) {
                    console.error(`[grok] Failed to parse tool arguments for ${tc.function.name}`, e);
                }

                const resultStr = await dispatchTool(tc.function.name, args, context);

                return {
                    tool_call_id: tc.id,
                    role: "tool" as const,
                    name: tc.function.name,
                    content: resultStr
                };
            })
        );

        // Append the tool results to the conversation
        messages.push(...toolResponses);
    }

    console.warn(`[grok] Max tool turns (${maxToolTurns}) exceeded. Forcing exit.`);
    // Get a final summary from the model before exiting if possible
    try {
        const finalResponse = await openai.chat.completions.create({
            model: config.GROK_MODEL,
            messages: messages
        });
        return { text: finalResponse.choices[0].message.content || "(Error: Agent loop exceeded maximum turns)" };
    } catch {
        return { text: "(Error: Agent loop exceeded maximum turns)" };
    }
}
