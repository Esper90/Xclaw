import { config } from "../../config";
import { Bot, session } from "grammy";
import type { SessionData } from "./session";

export type BotContext = import("grammy").Context & {
    session: SessionData;
};

export const bot = new Bot<BotContext>(config.TELEGRAM_BOT_TOKEN);

// ── In-memory session store (survives restarts only for current process) ─────
// We use a custom Map so we can read sessions from OUTSIDE the bot context
// (e.g. for background heartbeat/butler checks).
export const sessionMap = new Map<string, string>();

bot.use(
    session({
        initial: (): SessionData => ({
            buffer: [],
            voiceEnabled: false,
            heartbeatEnabled: false,
            braindumpMode: false,
            silencedUntil: 0,
            threadMode: false,
            threadBuffer: [],
            pendingDMs: [],
            pendingMentions: [],
            setupWizard: null,
        }),
        storage: {
            read: (key) => {
                const data = sessionMap.get(key);
                return data ? JSON.parse(data) : undefined;
            },
            write: (key, value) => {
                sessionMap.set(key, JSON.stringify(value));
            },
            delete: (key) => {
                sessionMap.delete(key);
            },
        },
    })
);
