export interface Message {
    role: "user" | "model";
    content: string;
    timestamp: number;
}

/** A DM fetched by the butler, held in session so the user can reply naturally */
export interface PendingDM {
    /** Display label shown to user: "A", "B", "C" … */
    label: string;
    id: string;
    conversationId: string;
    senderId: string;
    senderUsername?: string;
    /** Original DM text */
    text: string;
    /** Gemini-generated suggested reply */
    suggestedReply?: string;
}

export interface SessionData {
    /** Sliding window of recent messages */
    buffer: Message[];
    /** Whether to reply with a voice note */
    voiceEnabled: boolean;
    /** Whether to receive proactive heartbeat messages */
    heartbeatEnabled: boolean;
    /** DMs fetched in the last /dms or natural language check — cleared after replying */
    pendingDMs: PendingDM[];
}
