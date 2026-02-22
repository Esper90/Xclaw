import textToSpeech from "@google-cloud/text-to-speech";
import { config } from "../../config";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Initialize Google Cloud TTS client
// Supports both raw JSON string (e.g. Railway) or a path to a .json file
const ttsOptions: any = {};
if (config.GOOGLE_CREDENTIALS.startsWith("{")) {
    try {
        ttsOptions.credentials = JSON.parse(config.GOOGLE_CREDENTIALS);
    } catch (e) {
        console.error("Failed to parse GOOGLE_CREDENTIALS as JSON.", e);
    }
} else {
    ttsOptions.keyFilename = config.GOOGLE_CREDENTIALS;
}

const client = new textToSpeech.TextToSpeechClient(ttsOptions);

// ── Text Cleaning for TTS ────────────────────────────────────────────────
/**
 * Strips markdown symbols and artifacts that sound bad when read by TTS.
 */
function cleanTextForTTS(rawText: string): string {
    return rawText
        // Remove inline code and code blocks (replace with space to prevent run-on words)
        .replace(/`{1,3}[^`]*`{1,3}/g, " ")
        // Remove markdown links, keep the anchor text: [text](url) -> text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        // Remove raw URLs
        .replace(/(?:https?|ftp):\/\/[\n\S]+/g, "")
        // Remove bold/italics formatting
        .replace(/[*_]{1,3}/g, "")
        // Remove headers (e.g. # Header)
        .replace(/^#{1,6}\s+/gm, "")
        // Remove list items and blockquotes (e.g. - item, > quote)
        .replace(/^[-+*>]\s+/gm, "")
        // Consolidate extra spaces and newlines
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Convert text to speech using Google Cloud TTS and return an MP3 Buffer.
 * Falls back gracefully: caller should catch errors and send text instead.
 */
export async function synthesizeSpeech(rawText: string): Promise<Buffer> {
    const text = cleanTextForTTS(rawText);

    if (text.length === 0) {
        throw new Error("Text was empty after TTS markdown cleaning");
    }

    const request = {
        input: { text },
        // Select the language and SSML voice gender (optional)
        voice: {
            languageCode: config.GOOGLE_TTS_VOICE.split("-").slice(0, 2).join("-"), // e.g., 'en-US'
            name: config.GOOGLE_TTS_VOICE // e.g., 'en-US-Standard-I'
        },
        // select the type of audio encoding
        audioConfig: { audioEncoding: "MP3" as const },
    };

    const [response] = await client.synthesizeSpeech(request);

    if (!response.audioContent) {
        throw new Error("No audio content returned from Google TTS");
    }

    return Buffer.from(response.audioContent);
}

/**
 * Write a synthesized speech Buffer to a temp MP3 file and return the path.
 * Caller is responsible for deleting the file after use.
 */
export async function synthesizeToFile(text: string): Promise<string> {
    const buffer = await synthesizeSpeech(text);
    const tmpFile = path.join(os.tmpdir(), `gc-tts-${Date.now()}.mp3`);
    fs.writeFileSync(tmpFile, buffer);
    return tmpFile;
}
