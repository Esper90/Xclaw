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
    GEMINI_MODEL: z.string().default("gemini-3-flash-preview"),
    GEMINI_EMBEDDING_MODEL: z.string().default("text-embedding-004"),

    // Pinecone
    PINECONE_API_KEY: z.string().min(10, "PINECONE_API_KEY is required"),
    PINECONE_INDEX_NAME: z.string().default("gravity-claw"),
    PINECONE_MASTER_KEY: z.string().optional(),

    // Grok (xAI)
    GROK_API_KEY: z.string().min(10, "GROK_API_KEY is required"),
    GROK_MODEL: z.string().default("grok-4-1-fast-non-reasoning"),

    // OpenAI (Used exclusively for Realtime Voice API via Twilio)
    OPENAI_API_KEY: z.string().optional(),

    // Groq
    GROQ_API_KEY: z.string().min(10, "GROQ_API_KEY is required"),

    // ─── Google Cloud TTS ────────────────────────────────────────────────────────
    GOOGLE_CREDENTIALS: z.string().min(10, "GOOGLE_CREDENTIALS is required (JSON string or path)"),
    GOOGLE_TTS_VOICE: z.string().default("en-US-Standard-I"), // Good default voice

    // ─── Inworld TTS ─────────────────────────────────────────────────────────────
    INWORLD_API_KEY: z.string().optional(),
    INWORLD_VOICE_ID: z.string().default("Alain"),


    // REST API
    REST_API_KEY: z.string().min(16, "REST_API_KEY must be at least 16 chars"),
    PORT: z.string().default("3000"),

    // AI Provider
    AI_PROVIDER: z.enum(["gemini"]).default("gemini"),

    // Heartbeat
    HEARTBEAT_CRON: z.string().default("0 */6 * * *"),

    // X (Twitter) API
    X_CONSUMER_KEY: z.string().optional(),
    X_CONSUMER_SECRET: z.string().optional(),
    X_ACCESS_TOKEN: z.string().optional(),
    X_ACCESS_SECRET: z.string().optional(),

    // Web Search API
    TAVILY_API_KEY: z.string().optional(),

    // X Webhook allowlists (optional — comma-separated handles without @)
    // When set, only these accounts trigger Telegram alerts.
    // Leave unset (or empty) to receive alerts from everyone.
    // Example: MENTION_ALLOWLIST=sageisthename1,elonmusk
    MENTION_ALLOWLIST: z.string().optional(),
    DM_ALLOWLIST: z.string().optional(),

    // GitHub (optional PAT for watcher)
    GITHUB_TOKEN: z.string().optional(),

    // ─── Supabase (multi-user credential store) ──────────────────────────────
    // Required for the user-owned-keys model.
    // Dashboard → Project Settings → API → URL and service_role secret key.
    SUPABASE_URL: z.string().trim().url().optional(),
    SUPABASE_SERVICE_KEY: z.string().trim().min(10).optional(),

    // Public Railway URL — needed so /setup can print the correct webhook URL to register
    RAILWAY_URL: z.string().optional(),
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
