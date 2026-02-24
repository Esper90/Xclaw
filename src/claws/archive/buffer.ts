import type { Message } from "../connect/session";
import type { Content } from "@google/generative-ai";

const BUFFER_SIZE = 20;

/**
 * Add a message to the session buffer, evicting oldest if over limit.
 */
export function addToBuffer(buffer: Message[], role: "user" | "model", content: string): Message[] {
    const updated: Message[] = [
        ...buffer,
        { role, content, timestamp: Date.now() },
    ];
    return updated.slice(-BUFFER_SIZE);
}

/**
 * Convert session buffer to Gemini Content[] history format.
 */
export function bufferToHistory(buffer: Message[]): Content[] {
    return buffer.map((m) => ({
        role: m.role,
        parts: [{ text: m.content }],
    }));
}
/**
 * Shortcut to record a full user-bot exchange (e.g. for commands) in the buffer.
 */
export function recordInteraction(buffer: Message[], userContent: string, modelContent: string): Message[] {
    let updated = addToBuffer(buffer, "user", userContent);
    updated = addToBuffer(updated, "model", modelContent);
    return updated;
}
