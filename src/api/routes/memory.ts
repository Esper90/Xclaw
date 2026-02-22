import { Router, type Request, type Response } from "express";
import { queryMemory, upsertMemory } from "../../claws/archive/pinecone";
import { z } from "zod";

export const memoryRouter = Router();

const querySchema = z.object({
    userId: z.string().min(1),
    query: z.string().min(1),
    topK: z.number().int().min(1).max(20).optional().default(5),
});

const updateSchema = z.object({
    userId: z.string().min(1),
    text: z.string().min(1),
    metadata: z.record(z.string()).optional(),
});

/**
 * POST /memory/query
 * Body: { userId: string, query: string, topK?: number }
 */
memoryRouter.post("/query", async (req: Request, res: Response) => {
    const parsed = querySchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Bad request", details: parsed.error.flatten() });
        return;
    }

    try {
        const { userId, query, topK } = parsed.data;
        const results = await queryMemory(userId, query, topK);
        res.json({ results });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: "Memory query failed", message: msg });
    }
});

/**
 * POST /memory/update
 * Body: { userId: string, text: string, metadata?: Record<string, string> }
 */
memoryRouter.post("/update", async (req: Request, res: Response) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Bad request", details: parsed.error.flatten() });
        return;
    }

    try {
        const { userId, text, metadata } = parsed.data;
        const id = await upsertMemory(userId, text, metadata ?? {});
        res.json({ success: true, id });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: "Memory update failed", message: msg });
    }
});
