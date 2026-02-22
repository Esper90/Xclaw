import { Router, type Request, type Response } from "express";
import { z } from "zod";

const pushSchema = z.object({
    userId: z.string().min(1),
    text: z.string().min(1),
});

// The bot instance is injected at server creation time
type SendFn = (chatId: number, text: string) => Promise<void>;
let _send: SendFn | null = null;

export function injectSendFunction(fn: SendFn): void {
    _send = fn;
}

export const draftsRouter = Router();

/**
 * POST /drafts/push
 * Body: { userId: string, text: string }
 * Sends a message to the user's Telegram chat from an external system.
 */
draftsRouter.post("/push", async (req: Request, res: Response) => {
    const parsed = pushSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Bad request", details: parsed.error.flatten() });
        return;
    }

    if (!_send) {
        res.status(503).json({ error: "Bot not ready", message: "Send function not initialized" });
        return;
    }

    const { userId, text } = parsed.data;
    const chatId = parseInt(userId, 10);

    if (isNaN(chatId)) {
        res.status(400).json({ error: "Bad request", message: "userId must be a numeric Telegram chat ID" });
        return;
    }

    try {
        await _send(chatId, text);
        res.json({ success: true, message: `Sent to chat ${chatId}` });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: "Failed to send message", message: msg });
    }
});
