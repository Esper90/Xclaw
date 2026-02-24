export interface Message {
    role: "user" | "model";
    content: string;
    timestamp: number;
}

/** A mention fetched by the butler, held in session so the user can reply naturally */
export interface PendingMention {
    /** Display label shown to user: "A", "B", "C" … */
    label: string;
    id: string;
    authorId: string;
    authorUsername?: string;
    /** Original mention text */
    text: string;
    /** AI-generated suggested reply draft */
    suggestedReply?: string;
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

// ── /setup wizard ─────────────────────────────────────────────────────────────

/** Steps in the X credential onboarding wizard. */
export type SetupStep =
    | "consumer_key"
    | "consumer_secret"
    | "access_token"
    | "access_secret";

export interface SetupWizardState {
    step: SetupStep;
    /** Credentials collected so far */
    partial: {
        consumer_key?: string;
        consumer_secret?: string;
        access_token?: string;
        access_secret?: string;
    };
    /** True when the user is re-entering a specific key pair after a failed validation */
    retryMode?: boolean;
}

export interface SessionData {
    /** Sliding window of recent messages */
    buffer: Message[];
    /** Whether to reply with a voice note */
    voiceEnabled: boolean;
    /** For Settings Menu inputs */
    awaitingSettingInput?: "timezone" | "dm_allowlist" | "mention_allowlist";
    /** Whether to receive proactive heartbeat messages */
    heartbeatEnabled: boolean;
    /** Whether voice inputs should be transcribed and saved without an AI reply */
    braindumpMode: boolean;
    /** Timestamp until which proactive messages are paused (0 if not silenced) */
    silencedUntil: number;
    /** Whether the user is actively building a thread */
    threadMode: boolean;
    /** The accumulated messages for the current thread */
    threadBuffer: string[];
    /** DMs fetched in the last /dms or natural language check — cleared after replying */
    pendingDMs: PendingDM[];
    /** Mentions fetched in the last /mentions or natural language check — cleared after replying */
    pendingMentions: PendingMention[];
    /** Active /setup wizard state — null when no setup in progress */
    setupWizard: SetupWizardState | null;
}
