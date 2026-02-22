export interface Message {
    role: "user" | "model";
    content: string;
    timestamp: number;
}

export interface SessionData {
    /** Sliding window of recent messages */
    buffer: Message[];
    /** Whether to reply with a voice note */
    voiceEnabled: boolean;
    /** Whether to receive proactive heartbeat messages */
    heartbeatEnabled: boolean;
}
