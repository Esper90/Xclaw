import type { BotContext } from "./bot";
import { allowedIds } from "../../config";

/**
 * grammY middleware: silently drops updates from users not in ALLOWED_TELEGRAM_IDS.
 */
export async function authMiddleware(
    ctx: BotContext,
    next: () => Promise<void>
): Promise<void> {
    const userId = ctx.from?.id;

    if (!userId || !allowedIds.has(userId)) {
        console.warn(`[auth] Blocked unauthorized user: ${userId ?? "unknown"}`);
        return; // drop silently — don't call next()
    }

    await next();
}
