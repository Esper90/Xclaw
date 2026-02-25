import express from "express";
import { apiKeyAuth } from "./auth";
import { memoryRouter } from "./routes/memory";
import { draftsRouter } from "./routes/drafts";
import { threadsRouter } from "./routes/threads";
import { butlerRouter } from "./routes/butler";
import { xWebhookRouter } from "./routes/xWebhook";
import { twilioRouter } from "./routes/twilio";
import { setupTwilioWebSocket } from "../claws/listen/voiceStreamHandler";
import { config } from "../config";

/**
 * Create and start the Express REST API server.
 * @param port - Port to listen on (from config)
 */
export function startApiServer(): void {
    const app = express();

    app.use(express.json());

    // ── Health check (no auth) ─────────────────────────────────────────────
    app.get("/health", (_req, res) => {
        console.log(`[health] Ping received at ${new Date().toISOString()}`);
        res.json({ status: "ok", service: "gravity-claw", ts: new Date().toISOString() });
    });

    // ── Protected routes ───────────────────────────────────────────────────
    app.use("/memory", apiKeyAuth, memoryRouter);
    app.use("/drafts", apiKeyAuth, draftsRouter);
    app.use("/threads", apiKeyAuth, threadsRouter);
    app.use("/butler", apiKeyAuth, butlerRouter);

    // ── X Account Activity webhook (no auth — X calls this directly) ───────
    // GET  /x-webhook  → CRC challenge (X verifies endpoint ownership)
    // POST /x-webhook  → real-time DM + mention push events
    app.use("/x-webhook", xWebhookRouter);

    // ── Twilio Voice webhook (no auth — Twilio calls this directly) ────────
    // POST /twilio/incoming → TwiML response pointing to /twilio/stream
    app.use("/twilio", twilioRouter);

    // ── 404 handler ────────────────────────────────────────────────────────
    app.use((_req, res) => {
        res.status(404).json({ error: "Not found" });
    });

    const port = parseInt(config.PORT, 10);
    const host = "0.0.0.0"; // Bind to all interfaces for Railway

    // We need the raw HTTP server to attach the WebSocket server to it
    const server = app.listen(port, host, () => {
        console.log(`🌐 REST API listening on ${host}:${port}`);
    });

    // Attach WebSockets
    setupTwilioWebSocket(server);
}
