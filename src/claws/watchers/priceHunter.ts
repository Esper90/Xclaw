import cron from "node-cron";
import { listAllUsers } from "../../db/userStore";
import { getUserProfile } from "../../db/profileStore";
import { performTavilySearch } from "../wire/tools/web_search";
import { checkAndConsumeTavilyBudget } from "../sense/apiBudget";
import { extractDeals } from "./priceParser";

const CHECK_CRON = "15 13 * * *"; // 13:15 UTC daily
const MAX_ITEMS_PER_USER = 3;

function isQuiet(prefs: Record<string, any>): boolean {
    if ((prefs as any).quietAll) return true;
    const start = Number(prefs.quietHoursStart);
    const end = Number(prefs.quietHoursEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    if (start === end) return false;
    const hour = new Date().getHours();
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
}

async function searchDeal(telegramId: number, item: string, targetPrice?: number): Promise<string> {
    const query = targetPrice
        ? `${item} best price today under $${targetPrice}`
        : `${item} best current deal price today`;

    try {
        const res = await performTavilySearch(query, 4);
        const deals = extractDeals(res, 3);
        if (deals.length === 0) return res.split("\n").slice(0, 6).join("\n");
        return deals
            .map((d) => `• ${d.title}${d.price ? ` — ${d.price}` : ""}${d.url ? `\n${d.url}` : ""}`)
            .join("\n");
    } catch (err: any) {
        return `Tavily search failed: ${err?.message ?? err}`;
    }
}

export function startPriceHunterWatcher(
    sendMessage: (chatId: number, text: string, extra?: { reply_markup?: any }) => Promise<void>
): void {
    cron.schedule(CHECK_CRON, async () => {
        try {
            const users = await listAllUsers();
            if (!users || users.length === 0) return;

            for (const user of users) {
                const telegramId = user.telegram_id;
                const profile = await getUserProfile(telegramId);
                const prefs = (profile.prefs || {}) as Record<string, any>;
                if (isQuiet(prefs)) continue;
                const wishlist = profile.wishlist ?? [];
                if (!wishlist.length) continue;

                const budget = await checkAndConsumeTavilyBudget(telegramId);
                if (!budget.allowed) {
                    console.log(`[price-hunter] Budget reached for ${telegramId}: ${budget.reason}`);
                    continue;
                }

                const items = wishlist.slice(0, MAX_ITEMS_PER_USER);
                const reports: string[] = [];

                for (const wish of items) {
                    const report = await searchDeal(telegramId, wish.item, wish.targetPrice);
                    reports.push(`🎯 ${wish.item}${wish.targetPrice ? ` (target $${wish.targetPrice})` : ""}\n${report}`);
                }

                if (reports.length === 0) continue;

                const message = [
                    "🛒 Price & Deal Hunter",
                    `Checked ${reports.length} wishlist item(s).`,
                    "",
                    ...reports,
                ]
                    .filter(Boolean)
                    .join("\n");

                const reply_markup = {
                    inline_keyboard: [
                        [
                            { text: "Remind me later", callback_data: "deals:remind" },
                            { text: "Dismiss", callback_data: "deals:dismiss" },
                        ],
                    ],
                };

                try {
                    await sendMessage(telegramId, message, { reply_markup });
                    console.log(`[price-hunter] Sent deals to ${telegramId} for ${reports.length} item(s)`);
                } catch (err) {
                    console.error(`[price-hunter] Failed to send to ${telegramId}:`, err);
                }
            }
        } catch (err) {
            console.error("[price-hunter] Loop failed:", err);
        }
    });

    console.log(`[price-hunter] Scheduler active — cron: "${CHECK_CRON}"`);
}
