import type { BotContext } from "../connect/bot";
import { handleText } from "./textHandler";
import { handleVoice } from "./voiceHandler";
import { registerHeartbeat, unregisterHeartbeat } from "../sense/heartbeat";
import { queryMemory } from "../archive/pinecone";
import { postTweet } from "../wire/xService";

/**
 * Register all bot message and command handlers on the bot instance.
 */
export function registerRoutes(bot: import("grammy").Bot<BotContext>): void {
    // ── Commands ─────────────────────────────────────────────────────────────

    bot.command("start", async (ctx) => {
        await ctx.reply(
            `🦾 *Xclaw online.*\n\n` +
            `I'm your private AI assistant with long-term memory.\n\n` +
            `*Commands:*\n` +
            `/voice on|off — Toggle voice replies\n` +
            `/heartbeat on|off — Toggle proactive check-ins\n` +
            `/memory <query> — Search your memories\n` +
            `/post <text> — Post a tweet to X\n` +
            `/help — Show this message`,
            { parse_mode: "Markdown" }
        );
    });

    bot.command("help", async (ctx) => {
        await ctx.reply(
            `🦾 *Xclaw — Help*\n\n` +
            `*X Integration:* You can now post to Twitter directly!\n` +
            `*/post <text>* — Draft and send a tweet from the bot\n\n` +
            `*Voice:* Send a voice note and I'll transcribe + respond.\n` +
            `*/voice on* — I reply back with audio\n` +
            `*/voice off* — Text-only replies (default)\n\n` +
            `*Memory:* I remember our conversations via semantic search.\n` +
            `*/memory <query>* — Search your long-term memories\n\n` +
            `*Heartbeat:* Proactive check-ins from me.\n` +
            `*/heartbeat on* — Enable check-ins\n` +
            `*/heartbeat off* — Disable check-ins`,
            { parse_mode: "Markdown" }
        );
    });

    bot.command("post", async (ctx) => {
        const text = ctx.match?.trim();
        if (!text) {
            await ctx.reply("Usage: /post <your tweet content>");
            return;
        }

        const waitMsg = await ctx.reply("🐦 Posting to X...");

        try {
            const tweetId = await postTweet(text);
            await ctx.api.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                `✅ *Tweet posted!*\n\nID: \`${tweetId}\`\nhttps://x.com/i/status/${tweetId}`,
                { parse_mode: "Markdown" }
            );
        } catch (err: any) {
            console.error("[router] /post failed:", err);
            await ctx.api.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                `❌ *X API Error:*\n\n${err.message}`,
                { parse_mode: "Markdown" }
            );
        }
    });

    bot.command("voice", async (ctx) => {
        const arg = ctx.match?.trim().toLowerCase();
        if (arg === "on") {
            ctx.session.voiceEnabled = true;
            await ctx.reply("🔊 Voice replies enabled. I'll respond with audio.");
        } else if (arg === "off") {
            ctx.session.voiceEnabled = false;
            await ctx.reply("🔇 Voice replies disabled. Text-only mode.");
        } else {
            const status = ctx.session.voiceEnabled ? "on" : "off";
            await ctx.reply(`Voice is currently *${status}*. Use /voice on or /voice off.`, {
                parse_mode: "Markdown",
            });
        }
    });

    bot.command("heartbeat", async (ctx) => {
        const arg = ctx.match?.trim().toLowerCase();
        const userId = String(ctx.from!.id);
        const chatId = ctx.chat.id;

        if (arg === "on") {
            ctx.session.heartbeatEnabled = true;
            registerHeartbeat(userId, chatId);
            await ctx.reply("💡 Heartbeat enabled. I'll check in with you proactively.");
        } else if (arg === "off") {
            ctx.session.heartbeatEnabled = false;
            unregisterHeartbeat(userId);
            await ctx.reply("🔕 Heartbeat disabled.");
        } else {
            const status = ctx.session.heartbeatEnabled ? "on" : "off";
            await ctx.reply(
                `Heartbeat is currently *${status}*. Use /heartbeat on or /heartbeat off.`,
                { parse_mode: "Markdown" }
            );
        }
    });

    bot.command("memory", async (ctx) => {
        const query = ctx.match?.trim();
        if (!query) {
            await ctx.reply("Usage: /memory <search query>\nExample: /memory what did we discuss about Xclaw");
            return;
        }

        const userId = String(ctx.from!.id);
        await ctx.reply("🔍 Searching memories...");

        try {
            const results = await queryMemory(userId, query, 5);
            if (results.length === 0) {
                await ctx.reply("📭 No relevant memories found.");
                return;
            }

            const formatted = results
                .filter((r) => r.score > 0.6)
                .map((r, i) => `*${i + 1}.* (${(r.score * 100).toFixed(0)}%) ${r.text}`)
                .join("\n\n");

            await ctx.reply(
                `🧠 *Memories for: "${query}"*\n\n${formatted || "No confident matches found."}`,
                { parse_mode: "Markdown" }
            );
        } catch (err) {
            await ctx.reply("❌ Memory search failed. Please try again.");
        }
    });

    // ── Voice / Audio messages ─────────────────────────────────────────────────
    bot.on("message:voice", handleVoice);
    bot.on("message:audio", handleVoice);

    // ── Text messages ─────────────────────────────────────────────────────────
    bot.on("message:text", async (ctx) => {
        const userMessage = ctx.message.text;
        if (!userMessage) return;

        // Show typing indicator
        await ctx.replyWithChatAction("typing");

        try {
            const reply = await handleText(ctx, userMessage);
            await ctx.reply(reply, { parse_mode: "Markdown" });
        } catch (err) {
            console.error("[router] Text handler error:", err);
            await ctx.reply("❌ Something went wrong. Please try again.");
        }
    });
}
