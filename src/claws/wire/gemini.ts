import { GoogleGenerativeAI, type Content, type FunctionDeclarationsTool } from "@google/generative-ai";
import { config } from "../../config";

const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);

export interface GeminiReply {
    text: string;
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

/**
 * Generate a reply from Gemini given a system prompt, conversation history,
 * user message, and optional tool definitions.
 */
export async function generateReply(
    systemPrompt: string,
    history: Content[],
    userMessage: string,
    tools?: FunctionDeclarationsTool[]
): Promise<GeminiReply> {
    const model = genAI.getGenerativeModel({
        model: config.GEMINI_MODEL,
        systemInstruction: systemPrompt,
    });

    const chat = model.startChat({
        history,
        ...(tools && tools.length > 0 ? { tools } : {}),
    });

    const result = await chat.sendMessage(userMessage);
    const response = result.response;

    // Check for function calls
    const functionCalls = response.functionCalls();
    if (functionCalls && functionCalls.length > 0) {
        return {
            text: response.text() || "",
            toolCalls: functionCalls.map((fc) => ({
                name: fc.name,
                args: fc.args as Record<string, unknown>,
            })),
        };
    }

    return { text: response.text() };
}
