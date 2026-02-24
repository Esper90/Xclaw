import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../../config";

const ai = new GoogleGenerativeAI(config.GEMINI_API_KEY);

/**
 * Sends a base64 encoded image to Gemini 1.5 Flash to generate a detailed description
 * suitable for long-term Pinecone memory storage.
 */
export async function describePhotoForMemory(
    base64Data: string,
    mimeType: string,
    userCaption?: string
): Promise<string> {
    const model = ai.getGenerativeModel({ model: config.GEMINI_MODEL });

    const prompt =
        `You are the vision module for a personal AI assistant. 
The user has sent you a photo to remember.` +
        (userCaption ? `\nUser's caption: "${userCaption}"` : "") +
        `\n\nDescribe this image in high detail so that a text-based semantic search engine can easily find it later. 
Include objects, text, people, setting, colors, and the overall context or vibe.
If there is text in the image, transcribe the important parts.
Start directly with the description.`;

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
