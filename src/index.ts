/**
 * Xclaw — Main Entrypoint
 * Boots: Config validation → Tools → Bot → REST API → Heartbeat scheduler
 */

// Load tools (registers side-effects into registry)
import "./claws/wire/tools/email";
import "./claws/wire/tools/calendar";
import "./claws/wire/tools/x";
import "./claws/wire/tools/search_memory";
import "./claws/wire/tools/x_inbox";
import "./claws/wire/tools/x_reply";
import "./claws/wire/tools/web_search";
import "./claws/wire/tools/user_settings";
import "./claws/wire/tools/set_reminder";
import "./claws/wire/tools/thread";

import { bot, sessionMap } from "./claws/connect/bot";
import { authMiddleware } from "./claws/connect/auth";
import { registerRoutes } from "./claws/listen/router";
import { startHeartbeat } from "./claws/sense/heartbeat";
import { startApiServer } from "./api/server";
import { injectSendFunction } from "./api/routes/drafts";
import { startButlerWatcher } from "./claws/wire/xButler";
import { injectWebhookSender } from "./api/routes/xWebhook";
import { startReminderWatcher } from "./db/reminderWatcher";

async function main(): Promise<void> {
    console.log("🦾 Starting Xclaw...");

    // ── 1. Attach security middleware ────────────────────────────────────────
    bot.use(authMiddleware);

    // ── 2. Register all message/command routes ───────────────────────────────
    registerRoutes(bot);

    // ── 3. Error handler ─────────────────────────────────────────────────────
    bot.catch((err) => {
        console.error("[bot] Unhandled error:", err.error);
    });

    // ── 4. Inject Telegram send function into REST /drafts/push ─────────────
    injectSendFunction(async (chatId, text) => {
        await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
    });

    // ── 4b. Inject sender into X webhook handler ──────────────────────────────
    injectWebhookSender(async (chatId, text) => {
        await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
    });

    // ── 5. Start REST API server ─────────────────────────────────────────────
    startApiServer();

    // Helper to peek into a user's session without sending a message
    // We read directly from the in-memory map exported by bot.ts.
    // grammY session keys for private chats are typically just the chat ID as a string.
    const isSilenced = async (userId: string) => {
        const raw = sessionMap.get(userId);
        if (!raw) return false;
        try {
            const data = JSON.parse(raw);
            return data.silencedUntil && data.silencedUntil > Date.now();
        } catch {
            return false;
        }
    };

    // ── 6. Start heartbeat scheduler ─────────────────────────────────────────
    startHeartbeat(
        async (chatId, text) => {
            await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
        },
        isSilenced
    );
    // ── 6b. Start butler background watcher (15-min X check for active users) ──
    startButlerWatcher(
        async (chatId, text) => {
            await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
        },
        isSilenced
    );
    // ── 6c. Start reminder background watcher (60s exact-time checks) ──────────
    startReminderWatcher(
        async (chatId, text) => {
            await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
        }
    );
    // ── 7. Launch bot (long-polling) ─────────────────────────────────────────
    // Graceful shutdown: tell Telegram to stop polling BEFORE the process exits.
    // Without this, Railway kills the old container mid-poll and the new instance
    // gets a 409 Conflict because Telegram thinks polling is still active.
    const shutdown = async (signal: string) => {
        console.log(`[bot] ${signal} received — stopping bot gracefully`);
        await bot.stop();
        process.exit(0);
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));

    // Prevent 409 Conflict crash loop on Railway redeploys:
    // Telegram's long-polling session isn't released instantly when the old container
    // shuts down. We wait 15s to ensure it clears before starting to poll.
    console.log("[bot] Waiting 15s for previous instance to release Telegram session...");
    await new Promise<void>(resolve => setTimeout(resolve, 15_000));

    await bot.start({
        drop_pending_updates: true,
        onStart: (info) => {
            console.log(`🤖 Xclaw is online — @${info.username}`);
        },
    });
}

main().catch((err) => {
    console.error("💥 Fatal startup error:", err);
    process.exit(1);
});
