import { GoogleGenerativeAI, type Content, type FunctionDeclarationsTool } from "@google/generative-ai";
import { config } from "../../config";

const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);

export interface GeminiReply {
    text: string;
}

/**
 * Generate a reply from Gemini given a system prompt, conversation history,
 * user message, and optional tool definitions.
 * 
 * Supports a "while" loop for up to `maxToolTurns` (default 5) so Xclaw 
 * can natively chain multiple tool actions (e.g., fetch DMs -> read -> reply).
 */
export async function generateReply(
    systemPrompt: string,
    history: Content[],
    userMessage: string,
    tools?: FunctionDeclarationsTool[],
    dispatchTool?: (name: string, args: Record<string, unknown>, context?: Record<string, unknown>) => Promise<string>,
    context?: Record<string, unknown>,
    maxToolTurns: number = 10
): Promise<GeminiReply> {
    const model = genAI.getGenerativeModel({
        model: config.GEMINI_MODEL,
        systemInstruction: systemPrompt,
    });

    const chat = model.startChat({
        history,
        ...(tools && tools.length > 0 ? { tools } : {}),
    });

    let currentResponse = await chat.sendMessage(userMessage);
    let turns = 0;
    let previousFunctionCallsJson = "";

    while (turns < maxToolTurns) {
        turns++;
        const functionCalls = currentResponse.response.functionCalls();
        const textPart = currentResponse.response.text();

        // If no tool calls, we're done
        if (!functionCalls || functionCalls.length === 0) {
            return { text: textPart || "" };
        }

        // --- Loop Prevention ---
        // If the model asks for exactly the same tool calls with the same arguments twice in a row,
        // it means it's stuck in an error loop (e.g. 403 Forbidden). Abort immediately.
        const currentFunctionCallsJson = JSON.stringify(functionCalls);
        if (currentFunctionCallsJson === previousFunctionCallsJson) {
            console.warn(`[gemini] Tool loop detected! Model called the exact same tools consecutively. Aborting.`);
            return { text: textPart || "(System Error: I encountered a persistent error while using tools and automatically halted to prevent a timeout. My previous drafts and context are still intact in our history.)" };
        }
        previousFunctionCallsJson = currentFunctionCallsJson;

        console.log(`[gemini] Turn ${turns}/${maxToolTurns} | Tools: ${functionCalls.map(f => f.name).join(", ")}`);

        // If we have tool calls but no dispatcher was provided (legacy route), just return text
        if (!dispatchTool) {
            console.warn(`[gemini] Model requested ${functionCalls.length} tools but no dispatcher provided.`);
            return { text: textPart || "(Error: Tool calls requested but not supported in this context)" };
        }

        // Execute all requested tools in parallel for this turn
        const functionResponses = await Promise.all(
            functionCalls.map(async (fc) => {
                const resultStr = await dispatchTool(fc.name, fc.args as Record<string, unknown>, context);
                return {
                    functionResponse: {
                        name: fc.name,
                        // We must wrap the result in an object for Gemini
                        response: { result: resultStr },
                    },
                };
            })
        );

        // Send the tool results back to the model to get its next action or final text
        currentResponse = await chat.sendMessage(functionResponses);
    }

    console.warn(`[gemini] Max tool turns (${maxToolTurns}) exceeded. Forcing exit.`);
    return { text: currentResponse.response.text() || "(Error: Agent loop exceeded maximum turns)" };
}
