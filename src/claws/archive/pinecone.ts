import { Pinecone } from "@pinecone-database/pinecone";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../../config";
import { getOrGeneratePineconeKey } from "../../db/userStore";
import { encryptPayload, decryptPayload } from "./crypto";

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

    let finalMetadata: Record<string, any> = { text, userId, ...metadata };

    try {
        const userKey = await getOrGeneratePineconeKey(Number(userId));
        if (userKey) {
            const encryptedStr = encryptPayload(finalMetadata, userKey);
            finalMetadata = { encrypted_payload: encryptedStr };
        }
    } catch (err) {
        console.error(`[pinecone] Failed to encrypt memory for user ${userId}:`, err);
        throw new Error("Encryption failed, memory discarded for privacy safety.");
    }

    await index.namespace(userId).upsert([
        {
            id,
            values,
            metadata: finalMetadata,
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

    let userKey: Buffer | null = null;
    try {
        userKey = await getOrGeneratePineconeKey(Number(userId));
    } catch (err) {
        console.error(`[pinecone] Failed to retrieve key for query decryption (userId: ${userId}):`, err);
    }

    return (results.matches ?? []).map((m) => {
        let meta = (m.metadata as Record<string, any>) ?? {};

        // Transparently decrypt if it's an encrypted payload
        if (meta.encrypted_payload && userKey) {
            try {
                meta = decryptPayload(meta.encrypted_payload, userKey);
            } catch (err) {
                console.error(`[pinecone] Failed to decrypt memory ${m.id}:`, err);
                meta = { text: "⚠️ [Encrypted Memory - Decryption Failed]" };
            }
        } else if (meta.encrypted_payload && !userKey) {
            console.error(`[pinecone] Cannot decrypt memory ${m.id} because userKey is missing.`);
            meta = { text: "⚠️ [Encrypted Memory - Key Unavailable]" };
        }

        return {
            id: m.id,
            text: (meta.text as string) ?? "",
            score: m.score ?? 0,
            metadata: meta,
        };
    });
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

/**
 * Natural language memory deletion.
 * Queries Pinecone for relevant memories, uses Gemini to pick the best match,
 * and deletes it.
 */
export async function forgetMemory(userId: string, query: string): Promise<string> {
    const ai = new GoogleGenerativeAI(config.GEMINI_API_KEY);
    const model = ai.getGenerativeModel({ model: config.GEMINI_MODEL });

    // Grab top 10 possible matches to give Gemini context
    const candidates = await queryMemory(userId, query, 10);

    if (candidates.length === 0) {
        return "📭 I couldn't find any memories matching that description to delete.";
    }

    const summaries = candidates.map((m, i) =>
        `[${i}] ID: ${m.id} | Score: ${(m.score * 100).toFixed(0)}% | Text: "${m.text}"`
    ).join("\n");

    const result = await model.generateContent(
        `The user wants to FORGET or DELETE a specific memory matching this description: "${query.replace(/"/g, "'")}"
        
Here are the top 10 closest memories I found:
${summaries}

Which ONE memory is the user most likely referring to? 
Reply with ONLY the exact string ID of the memory to delete. 
If none of these seem like a good match for the user's request, reply with the exact word "NONE".`
    );

    const answer = result.response.text().trim();

    if (answer === "NONE" || !answer) {
        return "🤷‍♂️ I found some somewhat related memories, but none seemed exactly like what you asked to delete. Try being more specific.";
    }

    const match = candidates.find(c => c.id === answer);
    if (!match) {
        return "❌ Found a match, but failed to delete it from the database. Try again.";
    }

    await deleteMemory(userId, [match.id]);
    return `✅ *Memory deleted:*\n_"${match.text}"_`;
}
