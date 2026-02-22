import { Router, type Request, type Response } from "express";
import { queryMemory, upsertMemory } from "../../claws/archive/pinecone";
import { postTweet } from "../../claws/wire/xService";
import { routeToModel } from "../../claws/wire/modelRouter";
import { z } from "zod";

export const threadsRouter = Router();

const createSchema = z.object({
    userId: z.string().min(1),
    transcription: z.string().min(1),
});

const publishSchema = z.object({
    userId: z.string().min(1),
    thread: z.array(z.string().min(1)).min(1),
});

/**
 * POST /threads/create
 * Body: { userId: string, transcription: string }
 * Transforms a raw transcription into a structured X thread using Gemini and memory context.
 */
threadsRouter.post("/create", async (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Bad request", details: parsed.error.flatten() });
        return;
    }

    try {
        const { userId, transcription } = parsed.data;

        // 1. Recall relevant memories for context
        let context = "";
        try {
            const memories = await queryMemory(userId, transcription, 5);
            if (memories.length > 0) {
                context = memories.map((m) => `• ${m.text}`).join("\n");
            }
        } catch (err) {
            console.warn("[threads] Memory recall failed, proceeding without context:", err);
        }

        // 2. Build system prompt for thread weaving
        const systemPrompt = `You are XClaw, a master thread weaver.
Task: Transform the user's brain-dump transcription into a compelling, high-quality X/Twitter thread.
Context: Use the following "Relevant Context" to enrich the thread with facts, personal voice, and continuity.

Rules:
1. Output MUST be a valid JSON array of strings. No other text.
2. Each string is ONE tweet.
3. Max 280 characters per tweet.
4. Use clear thread numbering (e.g., 1/5, 2/5 or 1/, 2/).
5. Maintain an engaging, high-signal, and authentic tone.

Relevant Context:
${context || "No specific context available."}
`;

        // 3. Call AI model for weaving
        const reply = await routeToModel(systemPrompt, [], `Transcription: ${transcription}`, []);

        // 4. Parse JSON result
        let thread: string[];
        try {
            // Remove markdown code blocks if the model included them
            const cleanedText = reply.text.replace(/```json/g, "").replace(/```/g, "").trim();
            thread = JSON.parse(cleanedText);

            if (!Array.isArray(thread)) {
                throw new Error("Model did not return an array");
            }
        } catch (parseErr) {
            console.error("[threads] Failed to parse model output as JSON:", reply.text);
            throw new Error("AI returned invalid thread format. Please try again.");
        }

        res.json({ thread });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: "Thread creation failed", message: msg });
    }
});

/**
 * POST /threads/publish
 * Body: { userId: string, thread: string[] }
 * Posts the thread to X in sequence and stores the result in memory.
 */
threadsRouter.post("/publish", async (req: Request, res: Response) => {
    const parsed = publishSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Bad request", details: parsed.error.flatten() });
        return;
    }

    try {
        const { userId, thread } = parsed.data;
        let lastTweetId: string | undefined;
        const postedIds: string[] = [];

        console.log(`[threads] Publishing thread for user ${userId} (${thread.length} tweets)`);

        for (const tweetText of thread) {
            lastTweetId = await postTweet(tweetText, lastTweetId);
            postedIds.push(lastTweetId);
            // Small delay to ensure order and avoid spam detection
            await new Promise(resolve => setTimeout(resolve, 800));
        }

        // Upsert the entire thread into Pinecone memory for future reference
        const threadTextForMemory = thread.map((t, i) => `Tweet ${i + 1}: ${t}`).join("\n\n");
        await upsertMemory(userId, `[PUBLISHED THREAD]\n${threadTextForMemory}`, {
            source: "thread-weaver",
            tweetIds: postedIds.join(","),
            count: String(thread.length)
        }).catch(err => console.warn("[threads] Memory upsert failed post-publish:", err));

        res.json({ success: true, tweetIds: postedIds, lastTweetId });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: "Thread publication failed", message: msg });
    }
});
