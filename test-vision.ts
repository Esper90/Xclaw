import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "./src/config";
import * as fs from "fs";

async function run() {
    console.log("Testing vision on:", config.GEMINI_MODEL);
    const ai = new GoogleGenerativeAI(config.GEMINI_API_KEY);
    const model = ai.getGenerativeModel({ model: config.GEMINI_MODEL });

    // Create a 1x1 black pixel base64 jpeg for testing
    const base64Data = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
    const mimeType = "image/jpeg";

    const parts = [
        {
            inlineData: {
                data: base64Data,
                mimeType,
            },
        },
        { text: "Describe this image in one word." },
    ];

    try {
        console.log("Calling generateContent...");
        const result = await Promise.race([
            model.generateContent(parts),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout after 10s")), 10000))
        ]) as any;
        console.log("Success! Response:", result.response.text());
    } catch (e: any) {
        console.error("Error:", e.message);
    }
}

run();
