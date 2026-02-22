import Groq from "groq-sdk";
import * as fs from "fs";
import { config } from "../../config";

const groq = new Groq({ apiKey: config.GROQ_API_KEY });

/**
 * Transcribe an audio file (OGG/MP3/WAV) using Groq Whisper.
 * @param filePath - Absolute path to the downloaded audio file.
 * @returns Transcript text.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
    const fileStream = fs.createReadStream(filePath);

    const transcription = await groq.audio.transcriptions.create({
        file: fileStream,
        model: "whisper-large-v3-turbo",
        response_format: "text",
        language: "en",
    });

    // SDK returns string when response_format is "text"
    return (transcription as unknown as string).trim();
}
