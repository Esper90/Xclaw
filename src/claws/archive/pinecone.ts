import { Pinecone } from "@pinecone-database/pinecone";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../../config";

const pc = new Pinecone({ apiKey: config.PINECONE_API_KEY });
const index = pc.index(config.PINECONE_INDEX_NAME);

const embedGenAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
const embedModel = embedGenAI.getGenerativeModel({ model: config.GEMINI_EMBEDDING_MODEL });


export interface MemoryRecord {
    id: string;
    text: string;
    score: number;
    metadata: Record<string, string>;
}

/**
 * Embed text using Gemini text-embedding-004.
 */
async function embed(text: string): Promise<number[]> {
    const result = await embedModel.embedContent(text);
    return result.embedding.values;
}

/**
 * Upsert a memory chunk into the user's Pinecone namespace.
 * Pass a stable `customId` to make the upsert idempotent (e.g. per-tweet mentions).
 * When omitted a timestamp-based ID is generated.
 */
export async function upsertMemory(
    userId: string,
    text: string,
    metadata: Record<string, string> = {},
    customId?: string
): Promise<string> {
    const id = customId ?? `${userId}-${Date.now()}`;
    const values = await embed(text);

    await index.namespace(userId).upsert([
        {
            id,
            values,
            metadata: { text, userId, ...metadata },
        },
    ]);

    return id;
}

/**
 * Semantic search over the user's memories.
 * Returns top-K results ordered by relevance.
 */
export async function queryMemory(
    userId: string,
    query: string,
    topK = 5
): Promise<MemoryRecord[]> {
    const values = await embed(query);

    const results = await index.namespace(userId).query({
        vector: values,
        topK,
        includeMetadata: true,
    });

    return (results.matches ?? []).map((m) => ({
        id: m.id,
        text: (m.metadata?.text as string) ?? "",
        score: m.score ?? 0,
        metadata: (m.metadata as Record<string, string>) ?? {},
    }));
}

/**
 * Delete specific memory IDs from the user's namespace.
 * If no IDs provided, wipes the entire namespace.
 */
export async function deleteMemory(
    userId: string,
    ids?: string[]
): Promise<void> {
    const ns = index.namespace(userId);
    if (ids && ids.length > 0) {
        await ns.deleteMany(ids);
    } else {
        await ns.deleteAll();
    }
}
