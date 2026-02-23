import type { BotContext } from "../connect/bot";
import { addToBuffer, bufferToHistory } from "../archive/buffer";
import { getCorePrompt } from "../archive/corePrompt";
import { queryMemory, upsertMemory } from "../archive/pinecone";
import { routeToModel } from "../wire/modelRouter";
import { registry } from "../wire/tools/registry";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../../config";
import { recordActivity } from "../sense/activityTracker";
const MIN_MEMORY_SCORE = 0.75;

const intentAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);

/**
 * Use Gemini to detect if the user is asking to enable or disable voice/TTS.
 * Returns "on", "off", or "none".
 */
async function detectVoiceIntent(message: string): Promise<"on" | "off" | "none"> {
    const model = intentAI.getGenerativeModel({ model: config.GEMINI_MODEL });
    const result = await model.generateContent(
        `You are a classifier. Does this message ask to ENABLE or DISABLE voice/TTS/audio/spoken replies?

ENABLE examples: "use your voice", "talk to me", "speak your replies", "use tts", "go to voice mode", "i want audio", "reply with voice", "start talking"
DISABLE examples: "stop talking", "text only", "turn off voice", "no more audio", "disable tts", "go back to text", "shut up with the voice"
NONE examples: general questions, statements, tasks unrelated to voice mode

Reply with exactly one word. Options: on / off / none

Message: "${message.replace(/"/g, "'")}"`
    );
    const answer = result.response.text().trim().toLowerCase().split(/\s/)[0];
    if (answer === "on") return "on";
    if (answer === "off") return "off";
    return "none";
}

/**
 * Full pipeline for a text message:
 * 0. Check for voice toggle intent (any phrasing)
 * 1. Add user message to buffer
 * 2. Recall relevant long-term memories from Pinecone
 * 3. Build system prompt (core + memories)
 * 4. Send to AI model
 * 5. Handle any tool calls
 * 6. Add model reply to buffer
 * 7. Upsert new memory
 * 8. Return final reply text
 */
export async function handleText(
    ctx: BotContext,
    userMessage: string
): Promise<string> {
    const userId = String(ctx.from!.id);

    // Track activity for butler background watcher
    recordActivity(userId);

    // 0. Thread Mode Intercept
    if (ctx.session.threadMode) {
        ctx.session.threadBuffer.push(userMessage);
        return `🧵 *Added to Thread Draft:*\n_"${userMessage}"_\n\n_Keep typing/talking, or type /finish to post._`;
    }

    // 0a. Voice intent check — catches any natural phrasing before full pipeline
    try {
        const voiceIntent = await detectVoiceIntent(userMessage);
        if (voiceIntent === "on") {
            ctx.session.voiceEnabled = true;
            return "🔊 Voice mode on — I'll reply with audio from now on.";
        }
        if (voiceIntent === "off") {
            ctx.session.voiceEnabled = false;
            return "🔇 Voice mode off — back to text.";
        }
    } catch (err) {
        // Non-fatal — if intent detection fails, just proceed normally
        console.warn("[textHandler] Voice intent check failed:", err);
    }

    // Removed legacy interceptors; Gemini now handles tools natively

    // 1. Update buffer with user message
    ctx.session.buffer = addToBuffer(ctx.session.buffer, "user", userMessage);

    // 2. Recall long-term memories
    let memorySuffix = "";
    try {
        const memories = await queryMemory(userId, userMessage, 5);
        const relevant = memories.filter((m) => m.score >= MIN_MEMORY_SCORE);
        if (relevant.length > 0) {
            memorySuffix =
                "\n\n--- Relevant memories recalled ---\n" +
                relevant.map((m) => `• ${m.text}`).join("\n") +
                "\n--- End of memories ---";
        }
    } catch (err) {
        console.warn(`[textHandler] Memory recall failed:`, err);
    }

    // 3. Build system prompt
    let systemPrompt = (await getCorePrompt(userId)) + memorySuffix;

    // Inject active DMs and Mentions into system prompt context so tools can reference them
    if (ctx.session.pendingDMs?.length > 0) {
        systemPrompt += "\n\n--- CURRENT VISIBLE DMs ---\n" + JSON.stringify(ctx.session.pendingDMs, null, 2);
    }
    if (ctx.session.pendingMentions?.length > 0) {
        systemPrompt += "\n\n--- CURRENT VISIBLE MENTIONS ---\n" + JSON.stringify(ctx.session.pendingMentions, null, 2);
    }

    const history = bufferToHistory(ctx.session.buffer.slice(0, -1));
    const tools = registry.toGeminiTools();

    // 4. Call AI model with recursive tool dispatch
    const reply = await routeToModel(
        systemPrompt,
        history,
        userMessage,
        tools,
        // Bind dispatch to registry so 'this' context isn't lost
        (name, args, executionCtx) => registry.dispatch(name, args, executionCtx),
        { ctx, userId, chatId: ctx.chat?.id }
    );

    const finalText = reply.text;

    // 5. Update buffer with model reply
    ctx.session.buffer = addToBuffer(ctx.session.buffer, "model", finalText);

    // 6. Upsert memory (async, don't block reply)
    upsertMemory(userId, `User: ${userMessage}\nAssistant: ${finalText}`, {
        source: "conversation",
    }).catch((err) => console.warn(`[textHandler] Memory upsert failed:`, err));

    return finalText;
}

