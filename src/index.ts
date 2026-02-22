/**
 * Gravity Claw — Main Entrypoint
 * Boots: Config validation → Tools → Bot → REST API → Heartbeat scheduler
 */

// Load tools (registers side-effects into registry)
import "./claws/wire/tools/email";
import "./claws/wire/tools/calendar";

import { bot } from "./claws/connect/bot";
import { authMiddleware } from "./claws/connect/auth";
import { registerRoutes } from "./claws/listen/router";
import { startHeartbeat } from "./claws/sense/heartbeat";
import { startApiServer } from "./api/server";
import { injectSendFunction } from "./api/routes/drafts";

async function main(): Promise<void> {
    console.log("🦾 Starting Gravity Claw...");

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

    // ── 5. Start REST API server ─────────────────────────────────────────────
    startApiServer();

    // ── 6. Start heartbeat scheduler ─────────────────────────────────────────
    startHeartbeat(async (chatId, text) => {
        await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
    });

    // ── 7. Launch bot (long-polling) ─────────────────────────────────────────
    await bot.start({
        onStart: (info) => {
            console.log(`🤖 Gravity Claw is online — @${info.username}`);
        },
    });
}

main().catch((err) => {
    console.error("💥 Fatal startup error:", err);
    process.exit(1);
});
