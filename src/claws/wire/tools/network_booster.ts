import { SchemaType } from "@google/generative-ai";
import { registry, McpTool } from "./registry";
import { hasUserXCreds } from "../../../db/getUserClient";

const networkBoosterTool: McpTool = {
    name: "network_booster",
    description: "Suggest collaborator profiles and intro DM drafts (requires X creds).",
    execute: async (args: { niche?: string; count?: number; userId?: string | number }, executionCtx?: Record<string, unknown>) => {
        const niche = (args.niche || "your niche").trim();
        const count = Math.min(Math.max(Number(args.count) || 3, 1), 5);

        const rawUserId = (args as any).userId
            ?? (executionCtx as any)?.userId
            ?? (executionCtx as any)?.ctx?.from?.id;
        const telegramId = Number(rawUserId);
        if (!Number.isFinite(telegramId)) {
            return "Error: Missing user ID for network booster.";
        }

        const hasCreds = await hasUserXCreds(telegramId);
        if (!hasCreds) {
            return "This tool needs your X keys. Run /setup, then ask again (e.g., 'find collaborators in AI agents').";
        }

        // Stubbed suggestions until full X graph fetch is wired.
        const picks = Array.from({ length: count }).map((_, idx) => ({
            handle: `@candidate_${idx + 1}`,
            reason: `Active in ${niche}; similar audience; potential collab fit`,
            draft: `Hey! Love your work on ${niche}. Want to swap signal boosts or collab on a small build?`
        }));

        const message = [
            `🤝 Network Booster (preview)`,
            `Niche: ${niche}`,
            "",
            ...picks.map((p, i) => `${i + 1}. ${p.handle}\n   • ${p.reason}\n   • DM draft: ${p.draft}`),
            "",
            "Buttons: Send DM | Follow",
            "(Graph-powered matching will pull from your recent followers/mentions next.)",
        ].filter(Boolean).join("\n");

        return message;
    },
    geminiDeclaration: {
        name: "network_booster",
        description: "Suggest collaborator profiles based on the user's niche and X graph (requires X creds).",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                niche: { type: SchemaType.STRING, description: "Focus area to scout (e.g., AI agents, Chrome extensions)." },
                count: { type: SchemaType.NUMBER, description: "How many profiles to suggest (1-5)." },
                userId: { type: SchemaType.STRING, description: "Telegram user ID for gating." },
            },
            required: ["niche"],
        },
    },
};

registry.register(networkBoosterTool);
