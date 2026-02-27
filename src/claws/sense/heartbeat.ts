import cron from "node-cron";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../../config";
import { getUser } from "../../db/userStore";
import { getUserProfile } from "../../db/profileStore";
import { resolveTimeZone } from "./time";

const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);

// Key: userId (string), Value: chatId (number)
const heartbeatRegistry = new Map<string, number>();

const DEFAULT_ACTIVE_HOURS = { start: 8, end: 21 }; // local hours
const WEEKEND_WRAPUP_RE = /\b(weekend|monday|wrap[\s-]*up|final\s+friday|disconnect this weekend)\b/i;

type LocalContext = {
    hour: number;
    weekday: string;
    localNow: string;
};

function getLocalContext(timezone: string): LocalContext {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "short",
        hour12: false,
        hour: "2-digit",
    }).formatToParts(now);

    const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Unknown";
    const localNow = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "short",
        month: "short",
        day: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
        timeZoneName: "short",
    }).format(now);

    return { hour, weekday, localNow };
}

function withinHeartbeatWindow(
    timezone: string,
    prefs: Record<string, any> | null | undefined
): boolean {
    const p = (prefs || {}) as Record<string, any>;
    if (p.quietAll) return false;

    const { hour } = getLocalContext(timezone);
    const startRaw = Number(p.quietHoursStart);
    const endRaw = Number(p.quietHoursEnd);
    const hasQuietRange = Number.isFinite(startRaw) && Number.isFinite(endRaw) && startRaw !== endRaw;

    if (hasQuietRange) {
        if (startRaw < endRaw) {
            if (hour >= startRaw && hour < endRaw) return false;
        } else {
            if (hour >= startRaw || hour < endRaw) return false;
        }
    }

    return hour >= DEFAULT_ACTIVE_HOURS.start && hour < DEFAULT_ACTIVE_HOURS.end;
}

function weekendToneAllowed(weekday: string, hour: number): boolean {
    // Only allow end-of-week framing after Friday late afternoon local time.
    return weekday.toLowerCase().startsWith("fri") && hour >= 16;
}

async function generateHeartbeatMessage(userId: string, timezone: string): Promise<string> {
    const local = getLocalContext(timezone);
    const allowWeekendTone = weekendToneAllowed(local.weekday, local.hour);

    const model = genAI.getGenerativeModel({
        model: config.GEMINI_MODEL,
        systemInstruction: `You are Xclaw, a proactive AI assistant.
Generate a brief, useful proactive check-in message for your user.
Be substantive: share a relevant thought, ask a useful question, or suggest a task focus.
Keep it to 2-3 sentences maximum. Do not be repetitive or generic.
Current UTC time: ${new Date().toUTCString()}
Current local user time: ${local.localNow}
Current local weekday: ${local.weekday}, local hour (24h): ${local.hour}
${allowWeekendTone
        ? "Weekend or wrap-up framing is allowed if natural."
        : "Do NOT mention weekend wrap-up, Monday planning, or 'as we wrap up Friday' phrasing."}`,
    });

    const result = await model.generateContent(
        `Generate a proactive check-in message for user ${userId}. Make it feel personal and timely.`
    );
    let text = result.response.text().trim();

    // Final guard in case the model ignores instructions.
    if (!allowWeekendTone && WEEKEND_WRAPUP_RE.test(text)) {
        text = "Quick check-in: what are your top one or two priorities right now, and what is the next step you want to take first?";
    }

    return text;
}

export function registerHeartbeat(userId: string, chatId: number): void {
    heartbeatRegistry.set(userId, chatId);
}

export function unregisterHeartbeat(userId: string): void {
    heartbeatRegistry.delete(userId);
}

export function hasHeartbeatSettings(userId: string): boolean {
    return heartbeatRegistry.has(userId);
}

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
                const telegramId = Number(userId);
                if (!Number.isFinite(telegramId)) {
                    console.warn(`[heartbeat] Skipped invalid userId=${userId}`);
                    continue;
                }

                if (await isSilenced(userId)) {
                    console.log(`[heartbeat] Skipped (silenced) for userId=${userId}`);
                    continue;
                }

                const [user, profile] = await Promise.all([
                    getUser(telegramId).catch(() => null),
                    getUserProfile(telegramId).catch(() => null),
                ]);
                const rawTimezone = user?.timezone ?? profile?.timezone ?? null;
                if (!rawTimezone) {
                    console.log(`[heartbeat] Skipped (timezone not set) for userId=${userId}`);
                    continue;
                }

                const timezone = resolveTimeZone(rawTimezone);
                const prefs = (profile?.prefs || {}) as Record<string, any>;

                if (!withinHeartbeatWindow(timezone, prefs)) {
                    console.log(`[heartbeat] Skipped (quiet/off-hours) for userId=${userId} tz=${timezone}`);
                    continue;
                }

                const message = await generateHeartbeatMessage(userId, timezone);
                await sendMessage(chatId, `Xclaw check-in:\n\n${message}`);
                console.log(`[heartbeat] Sent to userId=${userId}`);
            } catch (err) {
                console.error(`[heartbeat] Failed for userId=${userId}:`, err);
            }
        }
    });

    console.log(`[heartbeat] Scheduler active - cron: "${schedule}"`);
}
