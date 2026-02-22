import { config } from "../../config";
import { Bot, session } from "grammy";
import type { SessionData } from "./session";

export type BotContext = import("grammy").Context & {
    session: SessionData;
};

export const bot = new Bot<BotContext>(config.TELEGRAM_BOT_TOKEN);

// ── In-memory session (survives restarts only for current process) ──────────
bot.use(
    session({
        initial: (): SessionData => ({
            buffer: [],
            voiceEnabled: false,
            heartbeatEnabled: false,
        }),
    })
);
