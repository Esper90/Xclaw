import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../../config";

const ai = new GoogleGenerativeAI(config.GEMINI_API_KEY);

/**
 * Sends a base64 encoded document (like a PDF) or raw text to Gemini 3 Flash 
 * to generate a detailed summary suitable for Pinecone memory storage.
 */
export async function summarizeDocumentForMemory(
    base64Data: string,
    mimeType: string,
    fileName: string,
    userCaption?: string
): Promise<string> {
    const model = ai.getGenerativeModel({ model: config.GEMINI_MODEL });

    const prompt =
        `You are the document analysis module for a personal AI assistant. 
The user has uploaded a file named "${fileName}" to remember.` +
        (userCaption ? `\nUser's caption: "${userCaption}"` : "") +
        `\n\nRead this document carefully and provide a highly detailed, comprehensive summary so that a text-based semantic search engine can easily find it later. 
Extract key themes, important facts, dates, names, and actionable items.
Start directly with the summary.`;

    const parts = [
        {
            inlineData: {
                data: base64Data,
                mimeType,
            },
        },
        { text: prompt },
    ];

    const result = await model.generateContent(parts);
    return result.response.text().trim();
}
