import type { BotContext } from "../connect/bot";
import { handleText } from "./textHandler";
import { handleSettingsCommand, handleSettingsCallback, handleSettingTextInput } from "./settingsHandler.js";
import { handleVoice } from "./voiceHandler";
import { handlePhoto } from "./photoHandler";
import { handleDocument } from "./documentHandler";
import { registerHeartbeat, unregisterHeartbeat } from "../sense/heartbeat";
import { queryMemory, forgetMemory, upsertMemory, deleteMemory } from "../archive/pinecone";
import { postTweet } from "../wire/xService";
import { fetchMentions, fetchDMs } from "../wire/xButler";
import { TwitterApi } from "twitter-api-v2";
import { upsertUser, deleteUser, getUser, getOrGeneratePineconeKey } from "../../db/userStore";
import { deleteCachedProfile } from "../../db/xCacheStore";
import { createReminder, deleteAllRemindersForUser } from "../../db/reminders";
import { getUserProfile, updateUserProfile } from "../../db/profileStore";
import { getUpcomingPostsForUser } from "../../db/scheduledPosts";
import { invalidateUserXClient } from "../../db/getUserClient";
import { registerAndSubscribeWebhook } from "../../x/webhookManager";
import { config } from "../../config";
import { synthesizeToFile } from "../sense/tts";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { consumeToken } from "../sense/rateLimiter";
import { InputFile, InlineKeyboard } from "grammy";
import { recordInteraction } from "../archive/buffer";

const DM_LABELS = "ABCDEFGHIJKLMNOP".split("");
const SENTINEL_LABELS = DM_LABELS;

function formatLocalTime(iso: string, tz?: string | null): string {
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz || "UTC",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    });
    return formatter.format(new Date(iso));
}

type HabitPref = { name: string; targetPerDay?: number; unit?: string };

function normalizeHabits(prefs: Record<string, unknown> | null | undefined): HabitPref[] {
    const habits = Array.isArray((prefs as any)?.habits) ? (prefs as any).habits : [];
    return habits
        .map((h: any) => ({
            name: String(h?.name || "").trim(),
            targetPerDay: Number((h as any)?.targetPerDay) || undefined,
            unit: (h as any)?.unit ? String((h as any).unit) : undefined,
        }))
        .filter((h: HabitPref) => h.name.length > 0);
}

/**
 * Register all bot message and command handlers on the bot instance.
 */
export function registerRoutes(bot: import("grammy").Bot<BotContext>): void {
    // ── Global Safeguard Middleware ─────────────────────────────────────────
    bot.use(async (ctx, next) => {
        if (!ctx.from) return next();

        // Do not limit onboarding, account deletion, or privacy confirmation clicks
        const text = ctx.message?.text || ctx.callbackQuery?.data || "";
        if (text.startsWith("/setup") || text.startsWith("/deletekeys") || text.startsWith("privacy:")) {
            return next();
        }

        const telegramId = ctx.from.id;

        // 1. Rate Limiting Check (Token Bucket)
        if (!consumeToken(String(telegramId))) {
            if (ctx.callbackQuery) {
                await ctx.answerCallbackQuery({ text: "⏳ Whoa, slow down! Too many requests.", show_alert: true });
            } else {
                await ctx.reply("⏳ *Whoa, slow down!*\n\nI am processing too many requests from you at once. Please wait a few seconds.", { parse_mode: "Markdown" });
            }
            return;
        }

        // 2. Global Ban Check (Nuclear Option)
        try {
            const user = await getUser(telegramId);
            if (user?.is_banned) {
                if (ctx.callbackQuery) {
                    await ctx.answerCallbackQuery({ text: "🛑 Access Revoked", show_alert: true });
                } else {
                    await ctx.reply("🛑 *Access Revoked*\n\nYour access to Xclaw has been permanently disabled due to a violation of the Terms of Service.");
                }
                return;
            }
        } catch (err) {
            console.warn(`[router] Ban check failed for ${telegramId}:`, err);
        }

        return next();
    });

    // ── Commands ─────────────────────────────────────────────────────────────

    bot.command("start", async (ctx) => {
        await ctx.reply(
            `🦾 *Xclaw online.*\n\n` +
            `I'm your private AI assistant with long-term memory.\n\n` +
            `*Commands:*\n` +
            `/setup — Connect your X account (first-time setup)\n` +
            `/deletekeys — Remove your X credentials\n` +
            `/mentions — Check important X mentions\n` +
            `/dms — Check recent X DMs\n` +
            `/briefing — Get an audio summary of your X inbox\n` +
            `/post <text> — Post a tweet to X\n` +
            `/memory <query> — Search your memories\n` +
            `/forget <query> — Delete specific memories\n` +
            `/braindump on|off — Toggle spoken journal mode\n` +
            `/thread — Start building an X thread\n` +
            `/voice on|off — Toggle voice replies\n` +
            `/heartbeat on|off — Toggle proactive check-ins\n` +
            `/silence <dur> — Pause proactive messages\n` +
            `/settings — Open comprehensive settings menu\n` +
            `/help — Show this message\n\n` +
            `🔒 *Privacy & Control:*\n` +
            `_Use /exportkey to securely view your Pinecone AES-256 memory encryption key._\n` +
            `_Use /deletekeys at any time to instantly wipe your X credentials from our system._\n` +
            `_Use /forget <topic> to delete specific memories._\n` +
            `_Use /forgetall to permanently wipe your entire memory bank._\n` +
            `_Your data is never sold, shared, or used for advertising._`,
            { parse_mode: "Markdown" }
        );
    });

    bot.command("settings", handleSettingsCommand);

    bot.command("help", async (ctx) => {
        await ctx.reply(
            `🦾 *Xclaw — Help*\n\n` +
            `*X Butler:* Monitor and reply to your X activity\n` +
            `*/mentions* — Fetch important @mentions (AI-filtered)\n` +
            `*/dms* — Fetch recent DMs with reply suggestions\n\n` +
            `*X Integration:* Post to X directly\n` +
            `*/post <text>* — Draft and send a tweet\n\n` +
            `*Voice:* Send a voice note and I'll transcribe + respond.\n` +
            `*/voice on* — I reply back with audio\n` +
            `*/voice off* — Text-only replies (default)\n\n` +
            `*Memory:* I remember our conversations via semantic search.\n` +
            `*/memory <query>* — Search your long-term memories\n` +
            `*/forget <query>* — Describe a memory for me to delete\n\n` +
            `*Heartbeat:* Proactive check-ins from me.\n` +
            `*/heartbeat on* — Enable check-ins\n` +
            `*/heartbeat off* — Disable check-ins\n\n` +
            `🔒 *Privacy & Control:*\n` +
            `_Use /exportkey to securely view your Pinecone AES-256 memory encryption key._\n` +
            `_Use /deletekeys at any time to instantly wipe your X credentials from our system._\n` +
            `_Use /forget <topic> to delete specific memories._\n` +
            `_Use /forgetall to permanently wipe your entire memory bank._\n` +
            `_Your data is never sold, shared, or used for advertising._`,
            { parse_mode: "Markdown" }
        );
    });

    bot.command("scheduled", async (ctx) => {
        const telegramId = ctx.from!.id;
        const profile = await getUserProfile(telegramId).catch(() => null);
        const tz = profile?.timezone;
        const pending = await getUpcomingPostsForUser(telegramId);
        if (!pending.length) {
            await ctx.reply("No pending scheduled posts.");
            return;
        }

        const lines = pending.map((p) => `• ${formatLocalTime(p.post_at, tz)} — ${p.text.slice(0, 120)}`);
        await ctx.reply(
            "🗓️ Scheduled posts (next 10):\n" +
            lines.join("\n") +
            `\n\nTimes shown in ${tz || "UTC"}.`,
            { parse_mode: "Markdown" }
        );
    });

    bot.command("habit", async (ctx) => {
        const args = ctx.match?.trim() || "";
        const telegramId = ctx.from!.id;
        const profile = await getUserProfile(telegramId);
        const habits = normalizeHabits(profile.prefs);

        if (!args) {
            if (!habits.length) {
                await ctx.reply("No habits set. Usage: /habit <name> <target?> <unit?> — e.g., /habit code 60 minutes");
                return;
            }
            const log = (profile.prefs as any)?.habitLog || {};
            const today = new Date().toISOString().slice(0, 10);
            const lines = habits.map((h, i) => {
                const key = h.name.toLowerCase();
                const entry = log[key] && log[key].date === today ? log[key] : null;
                const progress = entry ? ` — today: ${entry.total}${h.unit ? " " + h.unit : ""}` : "";
                return `${i + 1}. ${h.name}${h.targetPerDay ? ` (${h.targetPerDay}${h.unit ? " " + h.unit : ""}/day)` : ""}${progress}`;
            });
            await ctx.reply(["Your habits:", "", ...lines].join("\n"));
            return;
        }

        const parts = args.split(/\s+/);
        const name = parts.shift() ?? "";
        if (!name) {
            await ctx.reply("Usage: /habit <name> <target?> <unit?> — e.g., /habit code 60 minutes");
            return;
        }
        let targetPerDay: number | undefined;
        let unit: string | undefined;
        if (parts.length) {
            const maybeNum = Number(parts[0]);
            if (Number.isFinite(maybeNum)) {
                targetPerDay = maybeNum;
                parts.shift();
                unit = parts.join(" ") || undefined;
            } else {
                unit = parts.join(" ") || undefined;
            }
        }

        const updated: HabitPref = { name, targetPerDay, unit };
        const nextHabits = [...habits];
        const idx = nextHabits.findIndex((h) => h.name.toLowerCase() === name.toLowerCase());
        if (idx >= 0) nextHabits[idx] = updated; else nextHabits.push(updated);

        const newPrefs = { ...(profile.prefs || {}) } as Record<string, unknown>;
        (newPrefs as any).habits = nextHabits;
        await updateUserProfile(telegramId, { prefs: newPrefs });

        await ctx.reply(`🧱 Habit saved: "${name}"${targetPerDay ? ` (${targetPerDay}${unit ? " " + unit : ""}/day)` : ""}.`);
    });

    bot.command("mentions", async (ctx) => {
        const userId = String(ctx.from!.id);
        const waitMsg = await ctx.reply("🔍 Checking your X mentions...");

        try {
            const mentions = await fetchMentions(userId, 10);

            if (mentions.length === 0) {
                await ctx.api.editMessageText(
                    ctx.chat.id,
                    waitMsg.message_id,
                    `📭 *No important mentions right now.*\n\nEither nothing new, or nothing scored high enough to surface. The butler checks every 15 min automatically.`,
                    { parse_mode: "Markdown" }
                );
                return;
            }

            // Store in session with labels so user can reply naturally backwards
            ctx.session.pendingMentions = mentions.map((m, i) => ({
                label: DM_LABELS[i] ?? String(i + 1),
                id: m.id,
                authorId: m.authorId,
                authorUsername: m.authorUsername,
                text: m.text,
                suggestedReply: m.suggestedReply,
            }));

            let message = `📣 *${mentions.length} important mention${mentions.length > 1 ? "s" : ""}:*\n\n`;

            for (const m of mentions) {
                message += `👤 @${m.authorUsername ?? m.authorId}\n`;
                message += `💬 ${m.text.slice(0, 200)}${m.text.length > 200 ? "…" : ""}\n`;
                message += `📊 Score: ${(m.importanceScore * 100).toFixed(0)}% | ❤️ ${m.engagement}\n`;
                if (m.suggestedReply) {
                    message += `💡 *Suggested:* ${m.suggestedReply.slice(0, 180)}\n`;
                }
                message += `🔗 https://x.com/i/status/${m.id}\n\n`;
            }

            try {
                await ctx.api.editMessageText(
                    ctx.chat.id,
                    waitMsg.message_id,
                    message.trim(),
                    { parse_mode: "Markdown" }
                );
            } catch (err) {
                await ctx.api.editMessageText(
                    ctx.chat.id,
                    waitMsg.message_id,
                    message.trim()
                );
            }

            // Record interaction for AI background context
            ctx.session.buffer = recordInteraction(ctx.session.buffer, `/mentions`, message.trim());
        } catch (err: any) {
            console.error("[router] /mentions failed:", err);
            await ctx.api.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                `❌ *Failed to fetch mentions:*\n${err.message}`,
                { parse_mode: "Markdown" }
            );
        }
    });

    bot.command("dms", async (ctx) => {
        const userId = String(ctx.from!.id);
        const waitMsg = await ctx.reply("📬 Checking your X DMs...");

        try {
            const dms = await fetchDMs(userId, 5);

            if (dms.length === 0) {
                ctx.session.pendingDMs = [];
                await ctx.api.editMessageText(
                    ctx.chat.id,
                    waitMsg.message_id,
                    `📭 *No DMs to show right now.*\n\nEither inbox is clear or DM permissions aren't enabled on your X app yet.`,
                    { parse_mode: "Markdown" }
                );
                return;
            }

            // Store with labels in session so user can reply naturally afterwards
            ctx.session.pendingDMs = dms.map((dm, i) => ({
                label: DM_LABELS[i] ?? String(i + 1),
                id: dm.id,
                conversationId: dm.conversationId,
                senderId: dm.senderId,
                senderUsername: dm.senderUsername,
                text: dm.text,
                suggestedReply: dm.suggestedReply,
            }));

            let message = `📨 *${dms.length} DM${dms.length > 1 ? "s" : ""}:*\n\n`;
            for (const p of ctx.session.pendingDMs) {
                message += `*[${p.label}]* 👤 @${p.senderUsername ?? p.senderId}\n`;
                message += `💬 ${p.text.slice(0, 220)}${p.text.length > 220 ? "…" : ""}\n`;
                if (p.suggestedReply) {
                    message += `💡 *Suggested:* ${p.suggestedReply.slice(0, 200)}\n`;
                }
                message += `\n`;
            }
            message += `_Reply naturally — e.g. "reply to A", "reply to all", "reply to B but ask if they're free Friday"_`;

            try {
                await ctx.api.editMessageText(
                    ctx.chat.id,
                    waitMsg.message_id,
                    message.trim(),
                    { parse_mode: "Markdown" }
                );
            } catch (err) {
                await ctx.api.editMessageText(
                    ctx.chat.id,
                    waitMsg.message_id,
                    message.trim()
                );
            }

            // Record interaction for AI background context
            ctx.session.buffer = recordInteraction(ctx.session.buffer, `/dms`, message.trim());
        } catch (err: any) {
            console.error("[router] /dms failed:", err);
            await ctx.api.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                `❌ *Failed to fetch DMs:*\n${err.message}`,
                { parse_mode: "Markdown" }
            );
        }
    });

    bot.command("briefing", async (ctx) => {
        const userId = String(ctx.from!.id);
        const waitMsg = await ctx.reply("🎙️ Preparing your Audio Briefing...");

        try {
            const [mentions, dms] = await Promise.all([
                fetchMentions(userId, 5),
                fetchDMs(userId, 5)
            ]);

            if (mentions.length === 0 && dms.length === 0) {
                await ctx.api.editMessageText(
                    ctx.chat.id,
                    waitMsg.message_id,
                    "📭 Your inbox is completely clear. No briefing needed!"
                );
                return;
            }

            await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, "🎙️ Writing script...");

            const mentionLines = mentions.map(m => `Mention from @${m.authorUsername || m.authorId}: "${m.text}"`);
            const dmLines = dms.map(d => `DM from @${d.senderUsername || d.senderId}: "${d.text}"`);

            const ai = new GoogleGenerativeAI(config.GEMINI_API_KEY);
            const model = ai.getGenerativeModel({ model: config.GEMINI_MODEL });

            const prompt = `You are a highly efficient, professional yet conversational personal assistant. 
Write a script for a quick daily audio briefing synthesizing the user's latest X (Twitter) notifications.
Keep it under 45 seconds when spoken (approx 100-120 words). 
Be conversational, write it exactly as it should be spoken (no emojis, no hashtags, spell out symbols if needed).
Start directly with the briefing.

DATA TO SUMMARIZE:
Mentions:
${mentionLines.join("\n") || "No new mentions."}

DMs:
${dmLines.join("\n") || "No new DMs."}`;

            const result = await model.generateContent(prompt);
            const script = result.response.text().trim();

            await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, "🎙️ Recording audio...");

            const ttsFile = await synthesizeToFile(script);

            await ctx.replyWithVoice(new InputFile(ttsFile), {
                caption: `🎙️ *Your Audio Briefing*\n\n_${script}_`,
                parse_mode: "Markdown"
            });

            // Record interaction
            ctx.session.buffer = recordInteraction(ctx.session.buffer, `/briefing`, `🎙️ Briefing prepared: "${script}"`);

            // Cleanup
            await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id);
            const fs = await import("fs");
            fs.unlinkSync(ttsFile);

        } catch (err: any) {
            console.error("[router] /briefing failed:", err);
            await ctx.api.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                "❌ Failed to generate the Audio Briefing."
            );
        }
    });

    bot.command("thread", async (ctx) => {
        ctx.session.threadMode = true;
        ctx.session.threadBuffer = [];
        const msg = "🧵 *Voice-to-Thread Builder: ACTIVE*\n\nSend me ideas via text or voice. I will accumulate them. When you're done, type `/finish` and I will format them into a cohesive X thread and post it seamlessly.\n\n_(To cancel, type `/cancelthread`)_";
        await ctx.reply(msg, { parse_mode: "Markdown" });

        // Record interaction
        ctx.session.buffer = recordInteraction(ctx.session.buffer, `/thread`, msg);
    });

    bot.command("cancelthread", async (ctx) => {
        if (!ctx.session.threadMode) {
            await ctx.reply("You are not currently building a thread.");
            return;
        }
        ctx.session.threadMode = false;
        ctx.session.threadBuffer = [];
        await ctx.reply("🧵 Thread builder cancelled.");
    });

    bot.command("finish", async (ctx) => {
        if (!ctx.session.threadMode) {
            await ctx.reply("⚠️ You are not currently building a thread. Use `/thread` to start one.", { parse_mode: "Markdown" });
            return;
        }

        const buffer = ctx.session.threadBuffer;
        if (buffer.length === 0) {
            ctx.session.threadMode = false;
            await ctx.reply("🧵 Thread builder cancelled (no drafts were added).", { parse_mode: "Markdown" });
            return;
        }

        const waitMsg = await ctx.reply("✍️ Compiling your thread...");

        let previousTweetId: string | undefined;
        let postedCount = 0;

        try {
            const ai = new GoogleGenerativeAI(config.GEMINI_API_KEY);
            const model = ai.getGenerativeModel({ model: config.GEMINI_MODEL });

            const prompt = `You are a professional social media manager. The user has provided a stream-of-consciousness draft (dictated via voice or text) for a Twitter/X thread.
Compile these notes into a cohesive, highly engaging X thread.
Rules:
1. Each tweet in the thread MUST be no more than 280 characters.
2. Ensure clear transitions between tweets.
3. Use a natural, conversational tone that matches the user's draft.
4. Output ONLY a valid JSON array of strings, where each string is a single tweet in the sequence. 
5. Do not use blockquotes or markdown in the JSON wrapper. Just raw JSON.

DRAFT NOTES:
${buffer.join("\n")}`;

            const result = await model.generateContent(prompt);
            const raw = result.response.text().trim().replace(/^```json\n?|```$/g, "").trim();
            const tweets: string[] = JSON.parse(raw);

            if (!Array.isArray(tweets) || tweets.length === 0) {
                throw new Error("AI returned invalid thread payload.");
            }

            await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, `🐦 Posting a thread of ${tweets.length} tweets to X...`);

            const userId = String(ctx.from!.id);

            for (let i = 0; i < tweets.length; i++) {
                const tweetText = tweets[i];
                previousTweetId = await postTweet(tweetText, userId, previousTweetId);
                postedCount++;

                // Track this published tweet into the user's RAG for the Viral Style Engine
                if (previousTweetId) {
                    await upsertMemory(userId, tweetText, {
                        source: "my_tweet",
                        tweetId: previousTweetId,
                        createdAt: new Date().toISOString(),
                        engagement: "0"
                    }, `${userId}-my_tweet-${previousTweetId}`);
                }

                // Delay slightly to be polite to the API
                await new Promise(r => setTimeout(r, 1000));
            }

            // Cleanup
            ctx.session.threadMode = false;
            ctx.session.threadBuffer = [];

            const finalMsg = `✅ *Thread posted successfully!*\n\nhttps://x.com/i/status/${previousTweetId}`;
            await ctx.api.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                finalMsg,
                { parse_mode: "Markdown" }
            );

            // Record interaction
            ctx.session.buffer = recordInteraction(ctx.session.buffer, `/finish`, finalMsg);

        } catch (err: any) {
            console.error("[router] /finish failed:", err);

            if (postedCount > 0) {
                ctx.session.threadMode = false;
                ctx.session.threadBuffer = [];
                await ctx.api.editMessageText(
                    ctx.chat.id,
                    waitMsg.message_id,
                    `❌ *Failed to post thread at tweet #${postedCount + 1}:*\n${err.message}\n\n_Tweets 1 to ${postedCount} were successfully published. The remaining drafts have been cleared from memory to prevent duplicates. Please check X and post the rest manually._`,
                    { parse_mode: "Markdown" }
                );
            } else {
                await ctx.api.editMessageText(
                    ctx.chat.id,
                    waitMsg.message_id,
                    `❌ *Failed to compile thread:*\n${err.message}\n\n_Don't worry, your drafted notes are still saved in memory. You can continue sending notes, or type \`/finish\` to try compiling again._`,
                    { parse_mode: "Markdown" }
                );
            }
        }
    });

    bot.command("post", async (ctx) => {
        const text = ctx.match?.trim();
        if (!text) {
            await ctx.reply("Usage: /post <your tweet content>");
            return;
        }
        const userId = String(ctx.from!.id);
        const waitMsg = await ctx.reply("🐦 Posting to X...");

        try {
            const tweetId = await postTweet(text, userId);

            // Track this published tweet into the user's RAG for the Viral Style Engine
            if (tweetId) {
                await upsertMemory(userId, text, {
                    source: "my_tweet",
                    tweetId: tweetId,
                    createdAt: new Date().toISOString(),
                    engagement: "0"
                }, `${userId}-my_tweet-${tweetId}`);
            }

            const successMsg = `✅ *Tweet posted!*\n\nID: \`${tweetId}\`\nhttps://x.com/i/status/${tweetId}`;
            await ctx.api.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                successMsg,
                { parse_mode: "Markdown" }
            );

            // Record interaction for AI background context
            ctx.session.buffer = recordInteraction(ctx.session.buffer, `/post ${text}`, successMsg);
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
            const msg = "🔊 Voice replies enabled. I'll respond with audio.";
            await ctx.reply(msg);
            ctx.session.buffer = recordInteraction(ctx.session.buffer, `/voice on`, msg);
        } else if (arg === "off") {
            ctx.session.voiceEnabled = false;
            const msg = "🔇 Voice replies disabled. Text-only mode.";
            await ctx.reply(msg);
            ctx.session.buffer = recordInteraction(ctx.session.buffer, `/voice off`, msg);
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
            const msg = "💡 Heartbeat enabled. I'll check in with you proactively.";
            await ctx.reply(msg);
            ctx.session.buffer = recordInteraction(ctx.session.buffer, `/heartbeat on`, msg);
        } else if (arg === "off") {
            ctx.session.heartbeatEnabled = false;
            unregisterHeartbeat(userId);
            const msg = "🔕 Heartbeat disabled.";
            await ctx.reply(msg);
            ctx.session.buffer = recordInteraction(ctx.session.buffer, `/heartbeat off`, msg);
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

            const response = `🧠 *Memories for: "${query}"*\n\n${formatted || "No confident matches found."}`;
            await ctx.reply(
                response,
                { parse_mode: "Markdown" }
            );

            // Record interaction for AI background context
            ctx.session.buffer = recordInteraction(ctx.session.buffer, `/memory ${query}`, response);
        } catch (err) {
            await ctx.reply("❌ Memory search failed. Please try again.");
        }
    });

    bot.command("forget", async (ctx) => {
        const query = ctx.match?.trim();
        if (!query) {
            await ctx.reply("Usage: `/forget <description>`\nExample: `/forget that idea about the new app`", { parse_mode: "Markdown" });
            return;
        }

        const userId = String(ctx.from!.id);
        await ctx.reply("🧠 Searching memory bank...");

        try {
            const result = await forgetMemory(userId, query);
            await ctx.reply(result, { parse_mode: "Markdown" });
            ctx.session.buffer = recordInteraction(ctx.session.buffer, `/forget ${query}`, result);
        } catch (err) {
            await ctx.reply("❌ Failed to delete memory. Please try again.");
        }
    });

    bot.command("forgetall", async (ctx) => {
        const keyboard = new InlineKeyboard()
            .text("❌ Cancel", "privacy:cancel")
            .text("🔥 YES, WIPE MEMORY", "privacy:confirm_forgetall");

        await ctx.reply(
            "⚠️ *WARNING: NUCLEAR OPTION*\n\n" +
            "This will instantly and permanently delete **EVERY** long-term memory I have of you. I will forget everything we've ever discussed.\n\n" +
            "Are you absolutely sure you want to do this?",
            { parse_mode: "Markdown", reply_markup: keyboard }
        );
    });

    bot.command("deletekeys", async (ctx) => {
        const keyboard = new InlineKeyboard()
            .text("❌ Cancel", "privacy:cancel")
            .text("🔥 YES, WIPE ACCOUNT", "privacy:confirm_deletekeys");

        await ctx.reply(
            "⚠️ *WARNING: TOTAL WIPE*\n\n" +
            "This will instantly delete your X API Keys, Settings, Allowlists, **AND** all your Long-Term Memories.\n\n" +
            "Xclaw will completely forget you exist. Are you sure?",
            { parse_mode: "Markdown", reply_markup: keyboard }
        );
    });

    // ── Privacy Confirmation Callbacks ───────────────────────────────────────
    bot.on("callback_query:data", async (ctx, next) => {
        const data = ctx.callbackQuery.data;

        // Inline button handling for brief, vibe, sentinel, deals, GitHub
        if (data.startsWith("brief:")) {
            const telegramId = ctx.from.id;
            if (data === "brief:read") {
                try {
                    const profile = await getUserProfile(telegramId);
                    const cache = profile.briefCache as any;
                    if (!cache) {
                        await ctx.answerCallbackQuery({ text: "No cached brief available." });
                        return;
                    }
                    const lines = [
                        "📖 Full Brief",
                        cache.headlines ?? "",
                        cache.mentions ?? "",
                        cache.calendar ?? "",
                        cache.weather ?? "",
                        cache.reminders ?? "",
                        cache.vibe ?? "",
                    ].filter(Boolean).join("\n");
                    await ctx.api.sendMessage(ctx.chat!.id, lines, { parse_mode: "Markdown" });
                } catch (err) {
                    console.warn("[callback] brief:read failed", err);
                }
            }
            if (data === "brief:follow") {
                const inOneHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
                await createReminder(telegramId, "Follow up on daily brief", inOneHour).catch(() => null);
                await ctx.api.sendMessage(ctx.chat!.id, "📌 Follow-up scheduled in ~1 hour.");
            }
            await ctx.answerCallbackQuery({ text: "Got it." });
            return;
        }

        if (data.startsWith("vibe:")) {
            const telegramId = ctx.from.id;
            const label = data.split(":")[1];
            if (label === "yes") {
                const in30 = new Date(Date.now() + 30 * 60 * 1000).toISOString();
                await createReminder(telegramId, "Take a 30-min recharge break.", in30).catch(() => null);
            } else if (label === "later") {
                const in3h = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
                await createReminder(telegramId, "Vibe check follow-up.", in3h).catch(() => null);
            }
            const msg = label === "yes"
                ? "✅ Recharge scheduled."
                : label === "later"
                    ? "⏰ I’ll remind you later."
                    : "👍 Staying focused.";
            await ctx.answerCallbackQuery({ text: msg });
            return;
        }

        if (data.startsWith("sentinel:")) {
            if (data.endsWith("approve")) {
                try {
                    const profile = await getUserProfile(ctx.from.id);
                    const cache = (profile.prefs as any)?.sentinelCache as Array<{ handle: string; text: string }>; 
                    if (!cache || cache.length === 0) {
                        await ctx.answerCallbackQuery({ text: "No cached digest." });
                        return;
                    }

                    const ai = new GoogleGenerativeAI(config.GEMINI_API_KEY);
                    const model = ai.getGenerativeModel({ model: config.GEMINI_MODEL });
                    const prompt = [
                        "Draft concise reply suggestions (<=220 chars) for these VIP tweets.",
                        "Tone: warm, direct, no hashtags unless natural.",
                        "Return numbered replies with the handle in each line.",
                        "Tweets:",
                        ...cache.map((t, i) => `${i + 1}) @${t.handle}: ${t.text}`),
                    ].join("\n");
                    const result = await model.generateContent(prompt);
                    const draftsRaw = result.response.text().trim();
                    const draftLines = draftsRaw
                        .split(/\r?\n/)
                        .map((l) => l.trim())
                        .filter(Boolean);

                    ctx.session.pendingMentions = cache.map((item, idx) => {
                        const label = SENTINEL_LABELS[idx] ?? String(idx + 1);
                        const draft = draftLines[idx] ?? draftLines[draftLines.length - 1] ?? item.text;
                        return {
                            label,
                            id: (cache as any)[idx].id ?? "",
                            authorId: item.handle,
                            authorUsername: item.handle,
                            text: item.text,
                            suggestedReply: draft,
                        } as any;
                    });

                    const preview = ctx.session.pendingMentions
                        .map((p) => `*[${p.label}]* @${p.authorUsername}: ${p.suggestedReply}`)
                        .join("\n\n");

                    await ctx.api.sendMessage(
                        ctx.chat!.id,
                        `🛰️ Reply drafts ready. Say "reply to A" etc.\n\n${preview}`,
                        { parse_mode: "Markdown" }
                    );
                } catch (err) {
                    console.warn("[callback] sentinel approve failed", err);
                    await ctx.api.sendMessage(ctx.chat!.id, "⚠️ Failed to generate reply drafts. Try again later.");
                }
                await ctx.answerCallbackQuery({ text: "Drafting..." });
                return;
            }
            await ctx.answerCallbackQuery({ text: "Ignored." });
            return;
        }

        if (data.startsWith("deals:")) {
            if (data.endsWith("remind")) {
                const telegramId = ctx.from.id;
                const in6h = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
                await createReminder(telegramId, "Recheck deals", in6h).catch(() => null);
            }
            await ctx.answerCallbackQuery({ text: data.endsWith("remind") ? "Will remind later." : "Dismissed." });
            return;
        }

        if (data.startsWith("gh:")) {
            if (data.endsWith("draft")) {
                const text = ctx.callbackQuery.message?.text ?? "";
                const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                const body = lines.slice(2); // drop header lines
                const draft = body.length > 0
                    ? `GitHub check-in: ${body.join(" | ")}`.slice(0, 260)
                    : "GitHub check-in: shipping steady. #buildinpublic";
                await ctx.api.sendMessage(ctx.chat!.id, `Draft idea:\n${draft}`);
            }
            await ctx.answerCallbackQuery({ text: data.endsWith("draft") ? "Draft ready." : "Dismissed." });
            return;
        }

        if (data === "privacy:cancel") {
            await ctx.api.editMessageText(
                ctx.chat!.id,
                ctx.callbackQuery.message!.message_id,
                "🛑 *Cancelled.*\nYour data is safe.",
                { parse_mode: "Markdown" }
            );
            await ctx.answerCallbackQuery();
            return;
        }

        if (data === "privacy:confirm_forgetall") {
            const userId = String(ctx.from.id);
            await ctx.api.editMessageText(
                ctx.chat!.id,
                ctx.callbackQuery.message!.message_id,
                "🧨 Wiping your entire memory bank...",
                { parse_mode: "Markdown" }
            );

            try {
                await deleteMemory(userId);
                const msg = "✅ *All memories deleted.*\n\nMy long-term memory has been completely wiped. I will start fresh from this point forward.";
                await ctx.api.editMessageText(ctx.chat!.id, ctx.callbackQuery.message!.message_id, msg, { parse_mode: "Markdown" });
                ctx.session.buffer = recordInteraction(ctx.session.buffer, `/forgetall`, msg);
            } catch (err) {
                await ctx.api.editMessageText(ctx.chat!.id, ctx.callbackQuery.message!.message_id, "❌ Failed to wipe memories. Please try again.");
            }
            await ctx.answerCallbackQuery();
            return;
        }

        if (data === "privacy:confirm_deletekeys") {
            const telegramId = ctx.from.id;
            await ctx.api.editMessageText(
                ctx.chat!.id,
                ctx.callbackQuery.message!.message_id,
                "🗑️ Deleting all your data...",
                { parse_mode: "Markdown" }
            );

            try {
                const user = await getUser(telegramId);
                await deleteUser(telegramId);
                invalidateUserXClient(telegramId);
                if (user?.x_username) {
                    await deleteCachedProfile(user.x_username).catch(() => { });
                }
                await deleteMemory(String(telegramId)).catch(() => { });
                await deleteAllRemindersForUser(telegramId).catch(() => { });

                const msg = "✅ *Account Data Wiped.*\n\nYour X API keys, settings, memories, reminders, and profile cache have been permanently deleted from our secure databases. Use /setup if you ever wish to reconnect.";
                await ctx.api.editMessageText(ctx.chat!.id, ctx.callbackQuery.message!.message_id, msg, { parse_mode: "Markdown" });
                ctx.session.buffer = []; // Clear short-term memory too
            } catch (err) {
                console.error("[router] /deletekeys failed:", err);
                await ctx.api.editMessageText(ctx.chat!.id, ctx.callbackQuery.message!.message_id, "❌ Failed to delete account. May already be deleted.");
            }
            await ctx.answerCallbackQuery();
            return;
        }

        // Pass to existing handlers (settingsHandler, etc.)
        return next();
    });

    bot.command("braindump", async (ctx) => {
        const arg = ctx.match?.trim().toLowerCase();
        if (arg === "on") {
            ctx.session.braindumpMode = true;
            const msg = "🧠 *Brain Dump Mode: ON*\n\nSend voice notes. I will transcribe them and save them to your long-term memory, but I will *not* reply or try to converse.\n(Use `/braindump off` to return to normal)";
            await ctx.reply(msg, { parse_mode: "Markdown" });
            ctx.session.buffer = recordInteraction(ctx.session.buffer, `/braindump on`, msg);
        } else if (arg === "off") {
            ctx.session.braindumpMode = false;
            const msg = "🧠 Brain Dump Mode: OFF. Normal conversational AI resumed.";
            await ctx.reply(msg);
            ctx.session.buffer = recordInteraction(ctx.session.buffer, `/braindump off`, msg);
        } else {
            const status = ctx.session.braindumpMode ? "on" : "off";
            await ctx.reply(`Brain Dump is currently *${status}*. Use \`/braindump on\` or \`/braindump off\`.\n\n_When ON, your voice notes are silently transcribed and memorized without me replying._`, { parse_mode: "Markdown" });
        }
    });

    bot.command("silence", async (ctx) => {
        const arg = ctx.match?.trim().toLowerCase();
        if (!arg) {
            if (ctx.session.silencedUntil > Date.now()) {
                const remainingRaw = Math.round((ctx.session.silencedUntil - Date.now()) / 60000);
                const remainingStr = remainingRaw > 60
                    ? `${(remainingRaw / 60).toFixed(1)} hours`
                    : `${remainingRaw} minutes`;
                await ctx.reply(`🤫 Silence mode is *active* for another ${remainingStr}.\nUse \`/silence off\` to resume notifications.`, { parse_mode: "Markdown" });
            } else {
                await ctx.reply("Usage: `/silence <duration>` (e.g. `2h`, `30m`) or `/silence off`", { parse_mode: "Markdown" });
            }
            return;
        }

        if (arg === "off" || arg === "stop") {
            ctx.session.silencedUntil = 0;
            await ctx.reply("🔔 Silence lifted. Normal checks resumed.");
            return;
        }

        const match = arg.match(/^(\d+)(h|m)$/);
        if (!match) {
            await ctx.reply("Invalid format. Use `h` for hours or `m` for minutes (e.g., `2h`, `45m`).", { parse_mode: "Markdown" });
            return;
        }

        const value = parseInt(match[1], 10);
        const unit = match[2];
        const ms = unit === "h" ? value * 60 * 60 * 1000 : value * 60 * 1000;

        ctx.session.silencedUntil = Date.now() + ms;
        const msg = `🤫 *Emergency Brake Pulled*\n\nQuiet mode engaged for ${value}${unit}. I won't send you any proactive messages or DMs until then.`;
        await ctx.reply(msg, { parse_mode: "Markdown" });
        ctx.session.buffer = recordInteraction(ctx.session.buffer, `/silence ${arg}`, msg);
    });

    bot.command("forget", async (ctx) => {
        const query = ctx.match?.trim();
        if (!query) {
            await ctx.reply("Usage: /forget <description of memory to delete>\nExample: /forget the conversation about Xclaw");
            return;
        }

        const userId = String(ctx.from!.id);
        const waitMsg = await ctx.reply("🗑️ Finding memory to delete...");

        try {
            const result = await forgetMemory(userId, query);
            await ctx.api.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                result,
                { parse_mode: "Markdown" }
            );
        } catch (err: any) {
            console.error("[router] /forget failed:", err);
            await ctx.api.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                "❌ Failed to delete memory. Please try again.",
                { parse_mode: "Markdown" }
            );
        }
    });

    bot.command("exportkey", async (ctx) => {
        const userId = ctx.from!.id;
        try {
            const userKey = await getOrGeneratePineconeKey(userId);
            if (!userKey) {
                await ctx.reply("❌ Necessary infrastructure is not configured. Cannot export key.");
                return;
            }

            await ctx.reply(
                `🔐 *Your Private Encryption Key*\n\n` +
                `This is the AES-256-GCM key used to encrypt your memories *before* they are sent to the vector database. ` +
                `The server only stores an encrypted version of this key using a master wrapper key.\n\n` +
                `\`${userKey.toString('hex')}\`\n\n` +
                `⚠️ *Do not share this key with anyone!*`,
                { parse_mode: "Markdown" }
            );
        } catch (err: any) {
            console.error("[router] /exportkey failed:", err);
            await ctx.reply("❌ Failed to retrieve your encryption key.", { parse_mode: "Markdown" });
        }
    });

    // ── /setup — X credential onboarding wizard ──────────────────────────────
    bot.command("setup", async (ctx) => {
        ctx.session.setupWizard = { step: "consumer_key", partial: {} };
        const msg = `🔑 *Connect your X account to Xclaw*\n\nWe need 4 keys... [Wizard Started]`; // Shortened for log
        await ctx.reply(
            `🔑 *Connect your X account to Xclaw*\n\n` +
            `We need 4 keys from the X Developer Portal.\n` +
            `Follow these steps exactly — takes about 3 minutes.\n\n` +
            `─────────\n` +
            `*Step 1 — Open the portal and find your app*\n\n` +
            `1️⃣ Go to [developer.x.com](https://developer.x.com) and sign in\n` +
            `2️⃣ Click *"Apps"* in the left sidebar\n` +
            `3️⃣ Click on your app name\n` +
            `   _(No app yet? Click the button to create one first)_\n\n` +
            `You'll land on a page showing *"OAuth 1.0 Keys"*, *"Bearer Token"*, etc.\n\n` +
            `─────────\n` +
            `*⚠️ Check permissions first (skip if already set)*\n\n` +
            `On that page, click the small *"Edit settings"* button\n` +
            `Under *"App permissions"* select:\n` +
            `✅ *Read and write and Direct message*\n` +
            `Then click *Save* and go back to the keys page.\n` +
            `_(If you just changed this, click Regenerate on your Access Token too)_\n\n` +
            `─────────\n` +
            `*Step 2 — Get your Consumer Key*\n\n` +
            `On the keys page, look for the *"OAuth 1.0 Keys"* section.\n` +
            `You'll see *"Consumer Key"* with a row of dots ●●●●●●●●\n\n` +
            `👉 Click *"Show"* next to it\n` +
            `Two values will appear — copy the *first one* (the shorter one)\n\n` +
            `👇 Paste the *Consumer Key* (first value) here:`,
            { parse_mode: "Markdown", link_preview_options: { is_disabled: true } }
        );
        ctx.session.buffer = recordInteraction(ctx.session.buffer, `/setup`, `[X Auth Setup Wizard Started]`);
    });

    // ── /deletekeys — remove stored X credentials ─────────────────────────────
    bot.command("deletekeys", async (ctx) => {
        const telegramId = ctx.from!.id;
        try {
            await deleteUser(telegramId);
            invalidateUserXClient(telegramId);
            await ctx.reply(
                "🗑 *X credentials removed.*\n\nRun /setup to connect a new account.",
                { parse_mode: "Markdown" }
            );
        } catch (err: any) {
            await ctx.reply(`❌ Failed to remove credentials: ${err.message}`);
        }
    });


    // ── Callback Queries (Inline Buttons) ──────────────────────────────────────
    bot.on("callback_query:data", async (ctx) => {
        const data = ctx.callbackQuery.data;
        const telegramId = String(ctx.from.id);

        if (data.startsWith("settings:")) {
            await handleSettingsCallback(ctx, data);
            return;
        }

        if (data.startsWith("delete_tweet:")) {
            const tweetId = data.split(":")[1];
            try {
                // Dynamically import to avoid circular dependencies if any
                const { deleteTweet } = await import("../wire/xService.js");
                const { deleteMemory } = await import("../archive/pinecone.js");

                await deleteTweet(tweetId, telegramId);

                try {
                    await deleteMemory(telegramId, [`${telegramId}-my_tweet-${tweetId}`]);
                } catch (e) { /* ignore memory delete err */ }

                await ctx.answerCallbackQuery({ text: "✅ Tweet deleted successfully!" });

                // Edit the original message to remove the button and strikethrough the text
                const originalText = ctx.callbackQuery.message?.text || "Tweet deleted.";
                await ctx.editMessageText(`~~${originalText}~~\n\n*(🗑 Undo successful)*`, { parse_mode: "Markdown" });
            } catch (err: any) {
                console.error("[router] Undo tweet failed:", err);
                await ctx.answerCallbackQuery({ text: `❌ Failed to delete: ${err.message}`, show_alert: true });
            }
        } else if (data.startsWith("habit:")) {
            const telegramIdNum = ctx.from.id;
            const profile = await getUserProfile(telegramIdNum);
            const habits = normalizeHabits(profile.prefs);
            if (!habits.length) {
                await ctx.answerCallbackQuery({ text: "No habits set yet.", show_alert: true });
                return;
            }

            const match = data.match(/^habit:(done|add|snooze)(?::(\d+))?$/);
            if (!match) {
                await ctx.answerCallbackQuery();
                return;
            }
            const action = match[1];
            const idx = Math.min(Number(match[2] ?? 0), habits.length - 1);
            const habit = habits[idx];
            const key = habit.name.trim().toLowerCase();
            const log = (profile.prefs as any)?.habitLog || {};
            const today = new Date().toISOString().slice(0, 10);
            const entry = log[key] && log[key].date === today
                ? log[key]
                : { date: today, total: 0, lastDone: null };

            if (action === "done") {
                entry.lastDone = new Date().toISOString();
                entry.total = entry.total || 0;
                log[key] = entry;
                const prefs = { ...(profile.prefs || {}) } as Record<string, unknown>;
                (prefs as any).habitLog = log;
                await updateUserProfile(telegramIdNum, { prefs });
                await ctx.answerCallbackQuery({ text: `✅ Marked "${habit.name}" as done today.` });
            } else if (action === "add") {
                const unit = habit.unit?.toLowerCase() || "";
                const increment = unit.includes("min") ? 15 : unit.includes("h") ? 1 : 1;
                entry.total = (entry.total || 0) + increment;
                entry.date = today;
                log[key] = entry;
                const prefs = { ...(profile.prefs || {}) } as Record<string, unknown>;
                (prefs as any).habitLog = log;
                await updateUserProfile(telegramIdNum, { prefs });
                await ctx.answerCallbackQuery({ text: `Logged +${increment}${habit.unit ? " " + habit.unit : ""} for "${habit.name}".` });
            } else if (action === "snooze") {
                await ctx.answerCallbackQuery({ text: "Snoozed for now." });
            } else {
                await ctx.answerCallbackQuery();
            }
        } else {
            await ctx.answerCallbackQuery(); // acknowledge unknown
        }
    });

    // ── Voice / Audio messages ─────────────────────────────────────────────────
    bot.on("message:voice", handleVoice);
    bot.on("message:audio", handleVoice);

    // ── Photos / Image messages ────────────────────────────────────────────────
    bot.on("message:photo", handlePhoto);

    // ── Document / File messages ───────────────────────────────────────────────
    bot.on("message:document", handleDocument);

    // ── Text messages ─────────────────────────────────────────────────────────
    bot.on("message:text", async (ctx) => {
        const userMessage = ctx.message.text;
        if (!userMessage) return;

        // Setup wizard intercept — handle credential inputs before general AI
        if (ctx.session.setupWizard) {
            await handleSetupWizard(ctx, userMessage);
            return;
        }

        // Settings intercept — handle text inputs like timezones
        if (ctx.session.awaitingSettingInput) {
            const handled = await handleSettingTextInput(ctx, userMessage);
            if (handled) return;
        }

        // Show typing indicator
        await ctx.replyWithChatAction("typing");

        try {
            const reply = await handleText(ctx, userMessage);
            try {
                await ctx.reply(reply, { parse_mode: "Markdown" });
            } catch (parseErr) {
                console.warn("[router] Markdown parse failed. Falling back to plain text.");
                await ctx.reply(reply);
            }
        } catch (err) {
            console.error("[router] Text handler error:", err);
            await ctx.reply("❌ Something went wrong. Please try again.");
        }
    });
}

// ── Setup wizard ──────────────────────────────────────────────────────────────
/**
 * Handle one step of the /setup credential wizard.
 * Called from the message:text handler when ctx.session.setupWizard is active.
 */
async function handleSetupWizard(ctx: BotContext, input: string): Promise<void> {
    const wizard = ctx.session.setupWizard!;
    const telegramId = ctx.from!.id;

    // Allow aborting mid-wizard
    if (input.trim().toLowerCase() === "/cancel") {
        ctx.session.setupWizard = null;
        await ctx.reply("❌ Setup cancelled.");
        return;
    }

    // Strip all non-printable / invisible Unicode characters (zero-width spaces,
    // non-breaking spaces, RTL marks, etc.) that Telegram copy-paste injects.
    // X keys are pure printable ASCII — anything outside 0x20–0x7E is noise.
    const trimmed = input.replace(/[^\x20-\x7E]/g, "").trim();
    // Basic sanity check — all four X tokens are long with no spaces
    if (!trimmed || trimmed.length < 10 || trimmed.includes(" ")) {
        await ctx.reply(
            `⚠️ *That doesn't look like a valid key.*\n\n` +
            `X keys and tokens:\n` +
            `• Have no spaces\n` +
            `• Are at least 10 characters long\n` +
            `• Should be copied exactly as shown in the developer portal\n\n` +
            `Please try again, or type /cancel to stop setup.`
        );
        return;
    }

    switch (wizard.step) {
        case "consumer_key":
            wizard.partial.consumer_key = trimmed;
            wizard.step = "consumer_secret";
            await ctx.reply(
                `✅ *Consumer Key saved!*\n\n` +
                `─────────\n` +
                `*${wizard.retryMode ? "Re-enter" : "Step 2 of 4 —"} Consumer Secret*\n\n` +
                `Same *"Show"* dialog you just used — don't close it.\n\n` +
                `The *second value* shown below the Consumer Key is the *Consumer Secret*.\n` +
                `It's a longer random string (~50 characters).\n\n` +
                `_(If you already closed it, just click "Show" again)_\n\n` +
                `👇 Paste the *Consumer Secret* (second value) here:`,
                { parse_mode: "Markdown" }
            );
            break;

        case "consumer_secret":
            wizard.partial.consumer_secret = trimmed;
            wizard.step = "access_token";
            await ctx.reply(
                `✅ *Consumer Secret saved!*\n\n` +
                `─────────\n` +
                `*${wizard.retryMode ? "Re-enter" : "Step 3 of 4 —"} Access Token*\n\n` +
                `Go back to the keys page (same page as before).\n\n` +
                `Scroll down a little — still under *"OAuth 1.0 Keys"*,\n` +
                `you'll see *"Access Token"* with a *Regenerate* button.\n\n` +
                `👉 Click *"Regenerate"*\n\n` +
                `⚠️ *A dialog will pop up showing TWO values:*\n` +
                `*Access Token* and *Access Token Secret*\n\n` +
                `📋 *Copy BOTH right now* before closing the dialog\n` +
                `(X won't show them again after you close it)\n\n` +
                `👇 Paste the *Access Token* (first value — starts with numbers and a dash) here:`,
                { parse_mode: "Markdown" }
            );
            break;

        case "access_token":
            wizard.partial.access_token = trimmed;
            wizard.step = "access_secret";
            await ctx.reply(
                `✅ *Access Token saved!*\n\n` +
                `─────────\n` +
                `*${wizard.retryMode ? "Re-enter" : "Step 4 of 4 —"} Access Token Secret*\n\n` +
                `This is the *second value* from the Regenerate dialog you just used.\n\n` +
                `• If you copied it already — paste it now ✅\n` +
                `• If you closed the dialog — click *"Regenerate"* on Access Token again\n` +
                `  to generate a new pair, then copy the second value\n\n` +
                `💡 It looks like a long random string with no dash (~45 chars)\n\n` +
                `👇 Paste the *Access Token Secret* (second value) here:`,
                { parse_mode: "Markdown" }
            );
            break;

        case "access_secret": {
            wizard.partial.access_secret = trimmed;
            const validating = await ctx.reply("🔄 Validating credentials with X API…");

            // ── Step 1: Validate X credentials ────────────────────────────
            let xMe: Awaited<ReturnType<typeof TwitterApi.prototype.v1.verifyCredentials>>;
            try {
                console.log("[setup:validate] key lengths:", {
                    consumer_key: wizard.partial.consumer_key!.length,
                    consumer_secret: wizard.partial.consumer_secret!.length,
                    access_token: wizard.partial.access_token!.length,
                    access_secret: trimmed.length,
                });
                const testClient = new TwitterApi({
                    appKey: wizard.partial.consumer_key!,
                    appSecret: wizard.partial.consumer_secret!,
                    accessToken: wizard.partial.access_token!,
                    accessSecret: trimmed,
                });
                xMe = await testClient.v1.verifyCredentials();
            } catch (err: any) {
                const rawDump = JSON.stringify(err, Object.getOwnPropertyNames(err), 2);
                console.error("[setup:validate] X AUTH ERROR:", rawDump);
                const snippet = rawDump.length > 500 ? rawDump.slice(0, 500) + "…" : rawDump;
                wizard.step = "consumer_key";
                wizard.partial = {};
                wizard.retryMode = true;
                await ctx.api.editMessageText(
                    ctx.chat?.id ?? telegramId,
                    validating.message_id,
                    `❌ *X rejected these credentials.*\n\n` +
                    `\`\`\`\n${snippet}\n\`\`\`\n\n` +
                    `Re-enter all 4 keys — start with your *Consumer Key*:`,
                    { parse_mode: "Markdown" }
                );
                break;
            }

            // ── Step 2: Save to Supabase ───────────────────────────────────
            try {
                await upsertUser({
                    telegram_id: telegramId,
                    x_user_id: String(xMe.id_str ?? xMe.id),
                    x_username: xMe.screen_name,
                    x_consumer_key: wizard.partial.consumer_key!,
                    x_consumer_secret: wizard.partial.consumer_secret!,
                    x_access_token: wizard.partial.access_token!,
                    x_access_secret: trimmed,
                });
                invalidateUserXClient(telegramId);
            } catch (dbErr: any) {
                // Show exactly what URL+key Railway provided so user can spot mismatch
                const urlInUse = config.SUPABASE_URL ?? "(not set)";
                const keyLen = config.SUPABASE_SERVICE_KEY?.length ?? 0;
                const keyPreview = config.SUPABASE_SERVICE_KEY
                    ? config.SUPABASE_SERVICE_KEY.slice(0, 20) + "…" + config.SUPABASE_SERVICE_KEY.slice(-6)
                    : "(not set)";
                console.error("[setup:validate] SUPABASE ERROR:", dbErr?.message, { urlInUse, keyLen });
                ctx.session.setupWizard = null;
                await ctx.api.editMessageText(
                    ctx.chat?.id ?? telegramId,
                    validating.message_id,
                    `⚠️ *X credentials valid (@${xMe.screen_name}) but Supabase rejected the key.*\n\n` +
                    `*Error:* \`${dbErr?.message ?? "unknown"}\`\n\n` +
                    `*What Railway is sending to Supabase:*\n` +
                    `• URL: \`${urlInUse}\`\n` +
                    `• Key (${keyLen} chars): \`${keyPreview}\`\n\n` +
                    `⚠️ Make sure the URL and key are from the *same* Supabase project.\n` +
                    `Go to Supabase → your project → Settings → API and verify both match.\n\n` +
                    `Then update Railway Variables and redeploy.`,
                    { parse_mode: "Markdown" }
                );
                break;
            }

            // ── Step 3: Register webhook ───────────────────────────────────
            let webhookNote = "";
            try {
                const wh = await registerAndSubscribeWebhook(
                    wizard.partial.consumer_key!,
                    wizard.partial.consumer_secret!,
                    wizard.partial.access_token!,
                    trimmed,
                    telegramId
                );
                webhookNote = wh.subscribed
                    ? `\n\n✅ *Real-time alerts active!* DMs and mentions will arrive here instantly.\nWebhook ID: \`${wh.webhookId}\``
                    : `\n\n⚠️ Credentials saved but webhook subscription failed. Run /setup again to retry.`;
            } catch (whErr: any) {
                webhookNote = `\n\n⚠️ Credentials saved, but webhook setup failed: ${whErr.message}\nRun /setup again to retry.`;
            }

            ctx.session.setupWizard = null;
            await ctx.api.editMessageText(
                ctx.chat?.id ?? telegramId,
                validating.message_id,
                `✅ *Connected as @${xMe.screen_name}!*\n\n` +
                `Your credentials are stored securely in the database.` +
                webhookNote +
                `\n\n_Use /deletekeys to disconnect at any time._`,
                { parse_mode: "Markdown" }
            );
            break;
        }
    }
}
