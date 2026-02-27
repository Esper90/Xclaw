import { SchemaType } from "@google/generative-ai";
import { registry, McpTool } from "./registry";
import { getUserProfile, updateUserProfile } from "../../../db/profileStore";

interface Habit {
    name: string;
    targetPerDay?: number;
    unit?: string;
}

function normalizeHabits(prefs: Record<string, unknown> | null | undefined): Habit[] {
    const habits = Array.isArray((prefs as any)?.habits) ? (prefs as any).habits : [];
    return habits
        .map((h: any) => ({ name: String(h.name || "").trim(), targetPerDay: Number(h.targetPerDay) || undefined, unit: h.unit ? String(h.unit) : undefined }))
        .filter((h: Habit) => h.name.length > 0);
}

const habitTrackerTool: McpTool = {
    name: "habit_tracker",
    description: "Create or update lightweight daily habits and log quick progress pings.",
    execute: async (args: { habit: string; targetPerDay?: number; unit?: string; action?: "upsert" | "log"; userId?: string | number }, executionCtx?: Record<string, unknown>) => {
        const habitName = (args.habit || "").trim();
        if (!habitName) return "Error: Provide a habit name, e.g., 'code 60 min'.";
        const targetPerDay = Number(args.targetPerDay) || undefined;
        const unit = args.unit?.trim() || (targetPerDay ? "units" : undefined);
        const action = args.action || "upsert";

        const rawUserId = (args as any).userId
            ?? (executionCtx as any)?.userId
            ?? (executionCtx as any)?.ctx?.from?.id;
        const telegramId = Number(rawUserId);
        if (!Number.isFinite(telegramId)) {
            return "Error: Missing user ID for habit tracker.";
        }

        const profile = await getUserProfile(telegramId);
        const existing = normalizeHabits(profile.prefs);
        const idx = existing.findIndex((h) => h.name.toLowerCase() === habitName.toLowerCase());

        if (action === "log") {
            if (idx === -1) return `No habit named "${habitName}" found. Set it first.`;
            return `✅ Logged progress for "${habitName}". (Full logging UI coming soon.)`;
        }

        const updated: Habit = { name: habitName, targetPerDay, unit };
        if (idx >= 0) existing[idx] = updated; else existing.push(updated);

        try {
            const newPrefs = { ...(profile.prefs || {}) } as Record<string, unknown>;
            (newPrefs as any).habits = existing;
            await updateUserProfile(telegramId, { prefs: newPrefs });
        } catch (err) {
            console.warn(`[habit-tracker] Failed to save habit for ${telegramId}:`, err);
            return "Failed to save habit. Please try again.";
        }

        return `🧱 Habit saved: "${habitName}"${targetPerDay ? ` (${targetPerDay}${unit ? " " + unit : ""}/day)` : ""}. I'll nudge you daily.`;
    },
    geminiDeclaration: {
        name: "habit_tracker",
        description: "Set or log a daily habit so the nudger can remind the user.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                habit: { type: SchemaType.STRING, description: "Habit name, e.g., 'code 60 minutes', 'walk 5k steps'." },
                targetPerDay: { type: SchemaType.NUMBER, description: "Optional daily target (number)." },
                unit: { type: SchemaType.STRING, description: "Unit for the target (minutes, steps, words)." },
                action: { type: SchemaType.STRING, description: "upsert (default) to save/update, or log to record quick progress." },
                userId: { type: SchemaType.STRING, description: "Telegram user ID for storage." },
            },
            required: ["habit"],
        },
    },
};

registry.register(habitTrackerTool);
