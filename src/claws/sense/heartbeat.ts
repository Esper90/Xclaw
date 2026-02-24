import cron from "node-cron";
import { config } from "../../config";
import { allowedIds } from "../../config";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);

// We store chat IDs for users who have heartbeat enabled
// Key: userId (string), Value: chatId (number)
const heartbeatRegistry = new Map<string, number>();

/**
 * Register a user's chat ID for heartbeats.
 * Called by the Listen router when user enables heartbeat.
 */
export function registerHeartbeat(userId: string, chatId: number): void {
    heartbeatRegistry.set(userId, chatId);
}

/**
 * Unregister a user from heartbeat.
 */
export function unregisterHeartbeat(userId: string): void {
    heartbeatRegistry.delete(userId);
}

/**
 * Check if a user has heartbeat enabled.
 */
export function hasHeartbeatSettings(userId: string): boolean {
    return heartbeatRegistry.has(userId);
}

/**
 * Generate a proactive heartbeat message for a user.
 */
async function generateHeartbeatMessage(userId: string): Promise<string> {
    const model = genAI.getGenerativeModel({
        model: config.GEMINI_MODEL,
        systemInstruction: `You are Xclaw, a proactive AI assistant. 
Generate a brief, useful proactive check-in message for your user. 
Be substantive — share a relevant thought, ask a useful question, or suggest a task focus.
Keep it to 2-3 sentences maximum. Do not be repetitive or generic.
Current time: ${new Date().toUTCString()}`,
    });

    const result = await model.generateContent(
        `Generate a proactive check-in message for user ${userId}. Make it feel personal and timely.`
    );
    return result.response.text();
}

/**
 * Start the heartbeat cron scheduler.
 * Must be called AFTER the bot is running so sendMessage works.
 *
 * @param sendMessage - Function to send a Telegram message to a chatId
 */
export function startHeartbeat(
    sendMessage: (chatId: number, text: string) => Promise<void>,
    isSilenced: (userId: string) => Promise<boolean>
): void {
    const schedule = config.HEARTBEAT_CRON;

    if (!cron.validate(schedule)) {
        console.error(`[heartbeat] Invalid cron expression: "${schedule}"`);
        return;
    }

    cron.schedule(schedule, async () => {
        console.log(`[heartbeat] Firing for ${heartbeatRegistry.size} users`);

        for (const [userId, chatId] of heartbeatRegistry.entries()) {
            try {
                if (await isSilenced(userId)) {
                    console.log(`[heartbeat] Skipped (silenced) for userId=${userId}`);
                    continue;
                }
                const message = await generateHeartbeatMessage(userId);
                await sendMessage(chatId, `💡 *Xclaw check-in:*\n\n${message}`);
                console.log(`[heartbeat] Sent to userId=${userId}`);
            } catch (err) {
                console.error(`[heartbeat] Failed for userId=${userId}:`, err);
            }
        }
    });

    console.log(`[heartbeat] Scheduler active — cron: "${schedule}"`);
}
