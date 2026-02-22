import type { BotContext } from "../connect/bot";
import { addToBuffer, bufferToHistory } from "../archive/buffer";
import { getCorePrompt } from "../archive/corePrompt";
import { queryMemory, upsertMemory } from "../archive/pinecone";
import { routeToModel } from "../wire/modelRouter";
import { registry } from "../wire/tools/registry";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../../config";
import { recordActivity } from "../sense/activityTracker";
import { fetchMentions, fetchDMs, postButlerReply, searchDMs } from "../wire/xButler";
import type { PendingDM } from "../connect/session";

const LABELS = "ABCDEFGHIJKLMNOP".split("");

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
 * Use Gemini to detect if the user is asking about X (Twitter) DMs or mentions.
 * Returns "dms", "mentions", or "none".
 * NOTE: only called as fallback after detectXIntent returns "none".
 */
async function detectButlerIntent(message: string): Promise<"dms" | "mentions" | "none"> {
    const model = intentAI.getGenerativeModel({ model: config.GEMINI_MODEL });
    const result = await model.generateContent(
        `You are a classifier. Is the user asking to check their X (Twitter) DMs/messages (general inbox check), or their X mentions/replies?
This is for a GENERAL inbox fetch — NOT a specific search for a particular DM.

DMS examples (general fetch, no specific person/topic): "check my dms", "any new messages", "what's in my inbox", "any dms?", "show me my messages"
MENTIONS examples: "any mentions", "who mentioned me", "anything important on x", "what's new on twitter", "any replies", "check my mentions", "anything going on on x"
NONE examples: anything asking for a specific DM by person/topic/content, general questions unrelated to X

Reply with exactly one word. Options: dms / mentions / none

Message: "${message.replace(/"/g, "'")}"`
    );
    const answer = result.response.text().trim().toLowerCase().split(/\s/)[0];
    if (answer === "dms") return "dms";
    if (answer === "mentions") return "mentions";
    return "none";
}

/** Format DMs result into a clean Telegram markdown string and store in session */
async function runDMsReply(userId: string, ctx: BotContext): Promise<string> {
    const dms = await fetchDMs(userId, 5);
    if (dms.length === 0) {
        ctx.session.pendingDMs = [];
        return `📭 *No DMs to show right now.* Inbox looks clear — or DM permissions may not be enabled on your X app yet.`;
    }

    // Store in session with labels so user can say "reply to A"
    ctx.session.pendingDMs = dms.map((dm, i) => ({
        label: LABELS[i] ?? String(i + 1),
        id: dm.id,
        conversationId: dm.conversationId,
        senderId: dm.senderId,
        senderUsername: dm.senderUsername,
        text: dm.text,
        suggestedReply: dm.suggestedReply,
    } satisfies PendingDM));

    let msg = `📨 *${dms.length} DM${dms.length > 1 ? "s" : ""}:*\n\n`;
    for (const p of ctx.session.pendingDMs) {
        msg += `*[${p.label}]* 👤 @${p.senderUsername ?? p.senderId}\n`;
        msg += `💬 ${p.text.slice(0, 220)}${p.text.length > 220 ? "…" : ""}\n`;
        if (p.suggestedReply) {
            msg += `💡 *Suggested:* ${p.suggestedReply.slice(0, 200)}\n`;
        }
        msg += `\n`;
    }
    msg += `_Reply naturally — e.g. "reply to A", "reply to all", "reply to B but ask if they're free Friday"_`;
    return msg.trim();
}

/** Format mentions result into a clean Telegram markdown string */
async function runMentionsReply(userId: string): Promise<string> {
    const mentions = await fetchMentions(userId, 10);
    if (mentions.length === 0) {
        return `📭 *No important mentions right now.* Nothing new scored high enough to surface — the butler checks automatically every 15 min.`;
    }
    let msg = `📣 *${mentions.length} important mention${mentions.length > 1 ? "s" : ""}:*\n\n`;
    for (const m of mentions) {
        msg += `👤 @${m.authorUsername ?? m.authorId}\n`;
        msg += `💬 ${m.text.slice(0, 200)}${m.text.length > 200 ? "…" : ""}\n`;
        msg += `📊 Score: ${(m.importanceScore * 100).toFixed(0)}% | ❤️ ${m.engagement}\n`;
        if (m.suggestedReply) {
            msg += `💡 *Suggested:* ${m.suggestedReply.slice(0, 180)}\n`;
        }
        msg += `🔗 https://x.com/i/status/${m.id}\n\n`;
    }
    return msg.trim();
}

/**
 * Detect if the user is searching for specific DMs by description.
 * Returns { isSearch: true, query } or { isSearch: false }.
 * Only runs when the butler intent check returns "none".
 */
async function detectDMSearchIntent(
    message: string
): Promise<{ isSearch: boolean; query: string }> {
    const model = intentAI.getGenerativeModel({ model: config.GEMINI_MODEL });
    const result = await model.generateContent(
        `You are a classifier. Is the user asking to SEARCH or FIND specific DMs by sender name, username, content, topic, or any description?
If they mention ANY specific person, name, username, or topic they want to find — that is a SEARCH.

SEARCH examples — extract the core search query:
- "can you bring up the dms from sage is the name" → query: "from sage"
- "find the dm from @sageisthename1" → query: "from sageisthename1"  
- "find the dm from John" → query: "from John"
- "can you find the dm about the advertising issue" → query: "about advertising"
- "look for messages from support" → query: "from support"
- "find that dm about the refund" → query: "about refund"
- "any dms mentioning the collab?" → query: "mentioning collab"
- "bring me dms about my chrome extension" → query: "about chrome extension"
- "that message where they asked about pricing" → query: "asked about pricing"
- "bring up the messages from that person who asked about the deal" → query: "asked about the deal"
- "show me the dm from the ads team" → query: "from ads team"
- "the dm about the partnership" → query: "about partnership"

NOT SEARCH (return isSearch: false) — these are general inbox checks with no specific target:
- "check my dms"
- "any new messages?"
- "what's in my inbox"

Return ONLY valid JSON: {"isSearch": true, "query": "the search query"} or {"isSearch": false, "query": ""}
No explanation, no markdown, no code block.

Message: "${message.replace(/"/g, "'")}"`
    );

    try {
        const raw = result.response.text().trim().replace(/^```json\n?|```$/g, "").trim();
        const parsed = JSON.parse(raw);
        if (parsed.isSearch === true && typeof parsed.query === "string" && parsed.query.length > 0) {
            return { isSearch: true, query: parsed.query };
        }
    } catch { /* fall through */ }
    return { isSearch: false, query: "" };
}

/** Search DMs and format results into a Telegram markdown message, storing in session */
async function runDMSearchReply(userId: string, ctx: BotContext, query: string): Promise<string> {
    const dms = await searchDMs(userId, query);

    if (dms.length === 0) {
        // For person queries give a more specific hint about using the full handle
        const personMatch = query.match(/(?:from|by)\s*@?(\w+)/i);
        if (personMatch) {
            const name = personMatch[1];
            return `🔍 *No DMs found from "${name}"*\n\nTheir message wasn't in your recent DM history.\n\n💡 If their handle is different from their name, try: _"find dm from @theirfullhandle"_`;
        }
        return `🔍 *No DMs found matching:* "${query}"\n\nTried your recent messages — nothing matched. Try a different description.`;
    }

    ctx.session.pendingDMs = dms.map((dm, i) => ({
        label: LABELS[i] ?? String(i + 1),
        id: dm.id,
        conversationId: dm.conversationId,
        senderId: dm.senderId,
        senderUsername: dm.senderUsername,
        text: dm.text,
        suggestedReply: dm.suggestedReply,
    }));

    let msg = `🔍 *Found ${dms.length} DM${dms.length > 1 ? "s" : ""} matching "${query}":*\n\n`;
    for (const p of ctx.session.pendingDMs) {
        msg += `*[${p.label}]* 👤 @${p.senderUsername ?? p.senderId}\n`;
        msg += `💬 ${p.text.slice(0, 220)}${p.text.length > 220 ? "…" : ""}\n`;
        if (p.suggestedReply) {
            msg += `💡 *Suggested:* ${p.suggestedReply.slice(0, 200)}\n`;
        }
        msg += `\n`;
    }
    msg += `_Say "reply to A", "reply to all", or "reply to B but add…"_`;
    return msg.trim();
}

/**
 * Detect if the user wants to reply to one or more pending DMs.
 * Returns targets like ["A"], ["all"], ["B","C"] and an optional custom instruction.
 * Only called when pendingDMs.length > 0 to save tokens.
 */
async function detectReplyIntent(
    message: string,
    pendingLabels: string[]
): Promise<{ action: "reply" | "none"; targets: string[]; instruction?: string }> {
    const model = intentAI.getGenerativeModel({ model: config.GEMINI_MODEL });
    const labelsStr = pendingLabels.join(", ");
    const result = await model.generateContent(
        `You are a JSON classifier. The user has just been shown ${pendingLabels.length} DM(s) labeled: ${labelsStr}.
Decide if the user wants to REPLY to one or more of those DMs.

REPLY examples:
- "yeah reply to A" → {"action":"reply","targets":["A"]}
- "reply to all of them" → {"action":"reply","targets":["all"]}
- "go ahead and send" → {"action":"reply","targets":["all"]}
- "reply to B but ask if they can call tomorrow" → {"action":"reply","targets":["B"],"instruction":"ask if they can call tomorrow"}
- "reply to A and add that I'm running late" → {"action":"reply","targets":["A"],"instruction":"add that I'm running late"}
- "reply to A and C" → {"action":"reply","targets":["A","C"]}
- "send that to B" → {"action":"reply","targets":["B"]}
- "yes send it" → {"action":"reply","targets":["all"]}

NOT REPLY examples (return none):
- general questions
- asking to check DMs again
- anything not about replying

Return ONLY valid JSON. No explanation, no markdown, no code block.

Message: "${message.replace(/"/g, "'")}"`
    );

    try {
        const raw = result.response.text().trim().replace(/^```json\n?|```$/g, "").trim();
        const parsed = JSON.parse(raw);
        if (parsed.action === "reply" && Array.isArray(parsed.targets)) {
            return {
                action: "reply",
                targets: (parsed.targets as string[]).map((t) => t.toUpperCase()),
                instruction: parsed.instruction as string | undefined,
            };
        }
    } catch {
        // parse failed — fall through to none
    }
    return { action: "none", targets: [] };
}

/**
 * If the user gave a custom instruction, blend it with the suggested reply via Gemini.
 * Otherwise return the suggested reply as-is.
 */
async function buildReplyText(
    originalDM: string,
    suggested: string,
    instruction?: string
): Promise<string> {
    if (!instruction) return suggested;
    const model = intentAI.getGenerativeModel({ model: config.GEMINI_MODEL });
    const result = await model.generateContent(
        `You are writing a DM reply on behalf of the user.

Original DM received: "${originalDM.replace(/"/g, "'")}"
Suggested reply: "${suggested.replace(/"/g, "'")}"
User instruction: "${instruction.replace(/"/g, "'")}"

Write the final reply that incorporates the user's instruction. Keep it natural, concise (under 300 words) and conversational.
Return ONLY the reply text, nothing else.`
    );
    return result.response.text().trim();
}

/**
 * Execute replies to one or more pending DMs.
 * Handles "all", specific labels ["A","B"], custom instructions.
 */
async function executeReply(
    userId: string,
    ctx: BotContext,
    targets: string[],
    instruction?: string
): Promise<string> {
    const pending = ctx.session.pendingDMs;
    if (!pending || pending.length === 0) {
        return `📭 No DMs loaded. Say "check my dms" first so I can see what's in your inbox.`;
    }

    const toReply = targets[0] === "ALL"
        ? pending
        : pending.filter((p) => targets.includes(p.label.toUpperCase()));

    if (toReply.length === 0) {
        const available = pending.map((p) => p.label).join(", ");
        return `❓ Couldn't find those DMs. Available: ${available}. Try "reply to ${available[0]}" or "reply to all".`;
    }

    const results: string[] = [];
    for (const dm of toReply) {
        const base = dm.suggestedReply ?? `Thanks for reaching out, I'll get back to you soon.`;
        const finalText = await buildReplyText(dm.text, base, instruction);

        const replyResult = await postButlerReply(userId, dm.id, finalText, true, dm.conversationId);

        if (replyResult.success) {
            results.push(`✅ *[${dm.label}]* Replied to @${dm.senderUsername ?? dm.senderId}\n_"${finalText.slice(0, 120)}${finalText.length > 120 ? "…" : ""}"_`);
        } else {
            results.push(`❌ *[${dm.label}]* Failed to reply to @${dm.senderUsername ?? dm.senderId}: ${replyResult.error}`);
        }
    }

    // Clear replied DMs from session
    ctx.session.pendingDMs = pending.filter(
        (p) => !toReply.some((r) => r.label === p.label)
    );

    return results.join("\n\n");
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

    // 0. Voice intent check — catches any natural phrasing before full pipeline
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

    // 0b. DM reply intent — only runs if we have pending DMs in session (zero extra cost otherwise)
    if (ctx.session.pendingDMs?.length > 0) {
        try {
            const labels = ctx.session.pendingDMs.map((d) => d.label);
            const replyIntent = await detectReplyIntent(userMessage, labels);
            if (replyIntent.action === "reply") {
                return await executeReply(userId, ctx, replyIntent.targets, replyIntent.instruction);
            }
        } catch (err) {
            console.warn("[textHandler] Reply intent check failed:", err);
        }
    }

    // 0c. DM search intent — MUST run before general butler check.
    //     "bring up dms from sage" is a search, not a general fetch.
    //     Specific always wins over general.
    try {
        const searchIntent = await detectDMSearchIntent(userMessage);
        if (searchIntent.isSearch) {
            return await runDMSearchReply(userId, ctx, searchIntent.query);
        }
    } catch (err) {
        console.warn("[textHandler] DM search intent check failed:", err);
    }

    // 0d. General butler intent — catches broad X DM / mention queries
    try {
        const butlerIntent = await detectButlerIntent(userMessage);
        if (butlerIntent === "dms") {
            return await runDMsReply(userId, ctx);
        }
        if (butlerIntent === "mentions") {
            return await runMentionsReply(userId);
        }
    } catch (err) {
        console.warn("[textHandler] Butler intent check failed:", err);
    }

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
    const systemPrompt = getCorePrompt(userId) + memorySuffix;
    const history = bufferToHistory(ctx.session.buffer.slice(0, -1));
    const tools = registry.toGeminiTools();

    // 4. Call AI model
    const reply = await routeToModel(systemPrompt, history, userMessage, tools);

    // 5. Handle tool calls if present
    let finalText = reply.text;
    if (reply.toolCalls && reply.toolCalls.length > 0) {
        const toolResults: string[] = [];
        for (const tc of reply.toolCalls) {
            const result = await registry.dispatch(tc.name, tc.args);
            toolResults.push(`[${tc.name}]: ${result}`);
        }
        const followUp = await routeToModel(
            systemPrompt,
            history,
            `Tool results:\n${toolResults.join("\n")}\n\nUser's original request: ${userMessage}`,
            []
        );
        finalText = followUp.text;
    }

    // 6. Update buffer with model reply
    ctx.session.buffer = addToBuffer(ctx.session.buffer, "model", finalText);

    // 7. Upsert memory (async, don't block reply)
    upsertMemory(userId, `User: ${userMessage}\nAssistant: ${finalText}`, {
        source: "conversation",
    }).catch((err) => console.warn(`[textHandler] Memory upsert failed:`, err));

    return finalText;
}

