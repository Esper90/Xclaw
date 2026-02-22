/**
 * Butler API Routes — /butler/*
 *
 * Three endpoints for intelligent X (Twitter) monitoring and replying.
 * All routes require the standard REST_API_KEY bearer token (same as /memory, /drafts).
 *
 * Endpoints:
 *   POST /butler/mentions  → fetch + filter recent @mentions
 *   POST /butler/dms       → fetch + filter recent DMs
 *   POST /butler/reply     → post a reply and store it in memory
 *
 * No `userId` is required in the body — the bot defaults to the first
 * ALLOWED_TELEGRAM_IDS entry (the owner).  Pass `userId` explicitly to target
 * a specific Pinecone namespace when running multi-user.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { fetchMentions, fetchDMs, postButlerReply } from "../../claws/wire/xButler";
import { config } from "../../config";

// Default to first whitelisted user's Telegram ID as Pinecone namespace
function defaultUserId(): string {
    return config.ALLOWED_TELEGRAM_IDS.split(",")[0].trim();
}

// ── Validation schemas ────────────────────────────────────────────────────────

const mentionsSchema = z.object({
    userId: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional().default(10),
    since: z.string().optional(),
});

const dmsSchema = z.object({
    userId: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional().default(10),
    since: z.string().optional(),
});

const replySchema = z.object({
    userId: z.string().optional(),
    /** Tweet ID for mention replies; DM event ID for DM replies. */
    targetId: z.string().min(1),
    /** The reply text. Max 280 chars for tweets, up to 10 000 for DMs. */
    text: z.string().min(1).max(10_000),
    /** Set true when replying inside a DM conversation. */
    isDM: z.boolean().optional().default(false),
    /** Required when isDM=true: the dm_conversation_id from the DM object. */
    conversationId: z.string().optional(),
});

// ── Router ────────────────────────────────────────────────────────────────────

export const butlerRouter = Router();

/**
 * POST /butler/mentions
 *
 * Fetch recent X mentions, filter by Pinecone memory relevance + engagement,
 * and return important ones with suggested reply drafts.
 *
 * Body: { limit?: number, since?: string, userId?: string }
 * Response: { mentions: ButlerMention[], total_fetched: number, ts: string }
 */
butlerRouter.post("/mentions", async (req: Request, res: Response) => {
    const parsed = mentionsSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Bad request", details: parsed.error.flatten() });
        return;
    }

    const { userId, limit, since } = parsed.data;
    const xcUserId = userId ?? defaultUserId();

    try {
        const mentions = await fetchMentions(xcUserId, limit, since);
        res.json({
            mentions,
            total_important: mentions.length,
            ts: new Date().toISOString(),
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: "Mentions fetch failed", message: msg });
    }
});

/**
 * POST /butler/dms
 *
 * Fetch recent X DM events, filter by semantic relevance, and return
 * important ones with suggested reply drafts.
 *
 * Requires the X Developer App to have Direct Messages read permission.
 * If the app lacks dm.read, returns an empty `dms` array with a `warning`.
 *
 * Body: { limit?: number, since?: string, userId?: string }
 * Response: { dms: ButlerDM[], total_important: number, ts: string, warning?: string }
 */
butlerRouter.post("/dms", async (req: Request, res: Response) => {
    const parsed = dmsSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Bad request", details: parsed.error.flatten() });
        return;
    }

    const { userId, limit, since } = parsed.data;
    const xcUserId = userId ?? defaultUserId();

    try {
        const dms = await fetchDMs(xcUserId, limit, since);

        const response: Record<string, unknown> = {
            dms,
            total_important: dms.length,
            ts: new Date().toISOString(),
        };

        if (dms.length === 0) {
            response.hint =
                "Empty result. If you expected DMs, ensure your X app has " +
                "'Direct Messages' read permission (Settings → App permissions).";
        }

        res.json(response);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: "DMs fetch failed", message: msg });
    }
});

/**
 * POST /butler/reply
 *
 * Post a reply to a tweet OR inside a DM conversation, then auto-save the
 * reply to Pinecone memory.
 *
 * Body:
 *   {
 *     targetId: string,    // tweet ID or DM event ID
 *     text: string,        // reply text (max 280 for tweets, 10k for DMs)
 *     isDM?: boolean,      // default false
 *     conversationId?: string, // required when isDM=true
 *     userId?: string      // Pinecone namespace, defaults to owner
 *   }
 *
 * Response: { success: boolean, resultId?: string, memoryId?: string, error?: string }
 */
butlerRouter.post("/reply", async (req: Request, res: Response) => {
    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Bad request", details: parsed.error.flatten() });
        return;
    }

    const { userId, targetId, text, isDM, conversationId } = parsed.data;

    if (isDM && !conversationId) {
        res.status(400).json({
            error: "Bad request",
            message: "conversationId is required when isDM is true.",
        });
        return;
    }

    if (!isDM && text.length > 280) {
        res.status(400).json({
            error: "Bad request",
            message: "Tweet replies must be ≤ 280 characters.",
        });
        return;
    }

    const xcUserId = userId ?? defaultUserId();

    try {
        const result = await postButlerReply(xcUserId, targetId, text, isDM, conversationId);
        if (!result.success) {
            res.status(502).json(result);
            return;
        }
        res.json(result);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: "Reply failed", message: msg });
    }
});
