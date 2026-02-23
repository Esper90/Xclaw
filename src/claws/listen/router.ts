import type { BotContext } from "../connect/bot";
import { handleText } from "./textHandler";
import { handleVoice } from "./voiceHandler";
import { registerHeartbeat, unregisterHeartbeat } from "../sense/heartbeat";
import { queryMemory } from "../archive/pinecone";
import { postTweet } from "../wire/xService";
import { fetchMentions, fetchDMs } from "../wire/xButler";
import { TwitterApi } from "twitter-api-v2";
import { upsertUser, deleteUser } from "../../db/userStore";
import { invalidateUserXClient } from "../../db/getUserClient";
import { registerAndSubscribeWebhook } from "../../x/webhookManager";

const DM_LABELS = "ABCDEFGHIJKLMNOP".split("");

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
            `/setup — Connect your X account (first-time setup)\n` +
            `/deletekeys — Remove your X credentials\n` +
            `/mentions — Check important X mentions\n` +
            `/dms — Check recent X DMs\n` +
            `/post <text> — Post a tweet to X\n` +
            `/memory <query> — Search your memories\n` +
            `/voice on|off — Toggle voice replies\n` +
            `/heartbeat on|off — Toggle proactive check-ins\n` +
            `/help — Show this message`,
            { parse_mode: "Markdown" }
        );
    });

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
            `*/memory <query>* — Search your long-term memories\n\n` +
            `*Heartbeat:* Proactive check-ins from me.\n` +
            `*/heartbeat on* — Enable check-ins\n` +
            `*/heartbeat off* — Disable check-ins`,
            { parse_mode: "Markdown" }
        );
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

            await ctx.api.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                message.trim(),
                { parse_mode: "Markdown" }
            );
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

            await ctx.api.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                message.trim(),
                { parse_mode: "Markdown" }
            );
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

    // ── /setup — X credential onboarding wizard ──────────────────────────────
    bot.command("setup", async (ctx) => {
        ctx.session.setupWizard = { step: "consumer_key", partial: {} };
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

    // ── Voice / Audio messages ─────────────────────────────────────────────────
    bot.on("message:voice", handleVoice);
    bot.on("message:audio", handleVoice);

    // ── Text messages ─────────────────────────────────────────────────────────
    bot.on("message:text", async (ctx) => {
        const userMessage = ctx.message.text;
        if (!userMessage) return;

        // Setup wizard intercept — handle credential inputs before general AI
        if (ctx.session.setupWizard) {
            await handleSetupWizard(ctx, userMessage);
            return;
        }

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

    const trimmed = input.trim();
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

            try {
                // Verify credentials live — v2.me() returns 401 if anything is wrong
                const testClient = new TwitterApi({
                    appKey: wizard.partial.consumer_key!,
                    appSecret: wizard.partial.consumer_secret!,
                    accessToken: wizard.partial.access_token!,
                    accessSecret: trimmed,
                });
                const { data: xMe } = await testClient.v2.me({ "user.fields": ["id", "username"] });

                // Persist to Supabase
                await upsertUser({
                    telegram_id: telegramId,
                    x_user_id: xMe.id,
                    x_username: xMe.username,
                    x_consumer_key: wizard.partial.consumer_key!,
                    x_consumer_secret: wizard.partial.consumer_secret!,
                    x_access_token: wizard.partial.access_token!,
                    x_access_secret: trimmed,
                });
                invalidateUserXClient(telegramId);

                // Register & subscribe the per-user webhook
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
                    `✅ *Connected as @${xMe.username}!*\n\n` +
                    `Your credentials are stored securely in the database.` +
                    webhookNote +
                    `\n\n_Use /deletekeys to disconnect at any time._`,
                    { parse_mode: "Markdown" }
                );
            } catch (err: any) {
                // ── Log full raw error for diagnosis ──────────────────────
                console.error("[setup:validate] RAW ERROR:", JSON.stringify({
                    message: err?.message,
                    code: err?.code,
                    status: err?.data?.status ?? err?.status,
                    xErrors: err?.data?.errors ?? err?.errors,
                    detail: err?.data?.detail,
                    type: err?.data?.type,
                }, null, 2));

                const xCode: number | undefined =
                    err?.data?.errors?.[0]?.code ??
                    err?.errors?.[0]?.code ??
                    undefined;
                const xMessage: string =
                    err?.data?.errors?.[0]?.message ??
                    err?.data?.detail ??
                    err?.message ??
                    "unknown error";
                const httpStatus: number | undefined =
                    err?.data?.status ?? err?.status ?? err?.code;
                const msg: string = (err?.message ?? "").toLowerCase();

                const isConsumerBad =
                    xCode === 32 ||
                    msg.includes("consumer") ||
                    msg.includes("invalid api key") ||
                    msg.includes("api key");

                const isAccessBad =
                    xCode === 89 ||
                    xCode === 326 ||
                    msg.includes("token") ||
                    msg.includes("access");

                if (isConsumerBad && !isAccessBad) {
                    wizard.step = "consumer_key";
                    wizard.partial = {};
                    wizard.retryMode = true;
                    await ctx.api.editMessageText(
                        ctx.chat?.id ?? telegramId,
                        validating.message_id,
                        `❌ *Authentication failed*\n\n` +
                        `🔍 *Raw X error:* HTTP ${httpStatus ?? "?"} | code ${xCode ?? "?"} | \`${xMessage}\`\n\n` +
                        `We need to see this to diagnose the issue. Screenshot this message and share it.\n\n` +
                        `Then re-enter all 4 keys — start with your *Consumer Key*:`,
                        { parse_mode: "Markdown" }
                    );
                } else if (isAccessBad && !isConsumerBad) {
                    wizard.step = "access_token";
                    wizard.partial.access_token = undefined;
                    wizard.partial.access_secret = undefined;
                    wizard.retryMode = true;
                    await ctx.api.editMessageText(
                        ctx.chat?.id ?? telegramId,
                        validating.message_id,
                        `❌ *Authentication failed*\n\n` +
                        `🔍 *Raw X error:* HTTP ${httpStatus ?? "?"} | code ${xCode ?? "?"} | \`${xMessage}\`\n\n` +
                        `We need to see this to diagnose the issue. Screenshot this message and share it.\n\n` +
                        `Then re-enter your *Access Token* (keeps your Consumer Key):`,
                        { parse_mode: "Markdown" }
                    );
                } else {
                    wizard.step = "consumer_key";
                    wizard.partial = {};
                    wizard.retryMode = true;
                    await ctx.api.editMessageText(
                        ctx.chat?.id ?? telegramId,
                        validating.message_id,
                        `❌ *Authentication failed*\n\n` +
                        `🔍 *Raw X error:* HTTP ${httpStatus ?? "?"} | code ${xCode ?? "?"} | \`${xMessage}\`\n\n` +
                        `We need to see this to diagnose the issue. Screenshot this message and share it.\n\n` +
                        `Then re-enter all 4 keys — start with your *Consumer Key*:`,
                        { parse_mode: "Markdown" }
                    );
                }
            }
            break;
        }
    }
}
