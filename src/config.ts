import "dotenv/config";
import { z } from "zod";

const schema = z.object({
    // Telegram
    TELEGRAM_BOT_TOKEN: z.string().min(10, "TELEGRAM_BOT_TOKEN is required"),
    ALLOWED_TELEGRAM_IDS: z
        .string()
        .min(1, "ALLOWED_TELEGRAM_IDS must list at least one numeric ID"),

    // Gemini
    GEMINI_API_KEY: z.string().min(10, "GEMINI_API_KEY is required"),
    GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
    GEMINI_EMBEDDING_MODEL: z.string().default("text-embedding-004"),

    // Pinecone
    PINECONE_API_KEY: z.string().min(10, "PINECONE_API_KEY is required"),
    PINECONE_INDEX_NAME: z.string().default("gravity-claw"),

    // Groq
    GROQ_API_KEY: z.string().min(10, "GROQ_API_KEY is required"),

    // Google Cloud TTS
    GOOGLE_CREDENTIALS: z.string().min(10, "GOOGLE_CREDENTIALS is required (JSON string or path)"),
    GOOGLE_TTS_VOICE: z.string().default("en-US-Standard-I"), // Good default voice

    // REST API
    REST_API_KEY: z.string().min(16, "REST_API_KEY must be at least 16 chars"),
    PORT: z.string().default("3000"),

    // AI Provider
    AI_PROVIDER: z.enum(["gemini"]).default("gemini"),

    // Heartbeat
    HEARTBEAT_CRON: z.string().default("0 */6 * * *"),
});

function parseConfig() {
    const result = schema.safeParse(process.env);
    if (!result.success) {
        console.error("❌ Config validation failed:");
        result.error.issues.forEach((issue) => {
            console.error(`  • ${issue.path.join(".")}: ${issue.message}`);
        });
        process.exit(1);
    }
    return result.data;
}

export const config = parseConfig();

// Parsed helper: whitelist as Set<number>
export const allowedIds = new Set<number>(
    config.ALLOWED_TELEGRAM_IDS.split(",").map((id) => parseInt(id.trim(), 10))
);
