import { InlineKeyboard } from "grammy";
import type { BotContext } from "../connect/bot.js";
import { getUser, upsertUser } from "../../db/userStore.js";
import { hasHeartbeatSettings } from "../sense/heartbeat.js";
import { getUserProfile, updateUserProfile } from "../../db/profileStore";
import { DEFAULT_TAVILY_DAILY_MAX, DEFAULT_X_HOURLY_MAX } from "../sense/apiBudget";
import { getLocalDayKey, normalizeTimeZoneOrNull } from "../sense/time";

/**
 * Builds the inline keyboard for the Settings menu
 */
async function buildSettingsKeyboard(telegramId: number) {
    const user = await getUser(telegramId);
    const profile = await getUserProfile(telegramId);
    if (!user) {
        throw new Error("User not found in DB.");
    }

    // Determine Heartbeat status depending on if there's a file for them
    const heartbeatStatus = hasHeartbeatSettings(String(telegramId));

    const currentAi = user.preferred_ai || "grok";
    const aiDisplay = currentAi === "grok" ? "Grok 4.1" : "Gemini 3 Flash";

    const weatherLoc = (profile.prefs as any)?.weatherLocation;
    const contentMode = Boolean((profile.prefs as any)?.contentMode);
    const contentNiche = (profile.prefs as any)?.contentNiche as string | undefined;
    const newsTopics = Array.isArray((profile.prefs as any)?.newsTopics) ? (profile.prefs as any).newsTopics as string[] : [];
    const tavilyLimit = (profile.prefs as any)?.tavilyDailyLimit ?? undefined;
    const newsCadenceHours = (profile.prefs as any)?.newsFetchIntervalHours ?? undefined;
    const newsEnabled = (profile.prefs as any)?.newsEnabled !== false;
    const habitsEnabled = (profile.prefs as any)?.habitsEnabled !== false;
    const vibeEnabled = (profile.prefs as any)?.vibeEnabled !== false;
    const dealsEnabled = (profile.prefs as any)?.dealsEnabled !== false;
    const networkEnabled = (profile.prefs as any)?.networkEnabled !== false;
    const sentinelEnabled = (profile.prefs as any)?.sentinelEnabled !== false;
    const sentinelInterval = Number((profile.prefs as any)?.sentinelIntervalMins) || 30;

    const usage = ((profile.prefs as any)?.usage ?? {}) as Record<string, any>;
    const today = getLocalDayKey(user.timezone ?? profile.timezone ?? null);
    const tavilyCount = usage.tavily?.day === today ? usage.tavily.count ?? 0 : 0;
    const xCount = usage.x?.day === today ? usage.x.count ?? 0 : 0;
    const vipLabel = profile.vipList && profile.vipList.length > 0 ? `${profile.vipList.length} handles` : "Not Set";
    const vibeLabel = profile.vibeCheckFreqDays ? `${profile.vibeCheckFreqDays}d` : "3d";
    const wishlistLabel = profile.wishlist && profile.wishlist.length > 0 ? `${profile.wishlist.length} items` : "Empty";
    const reposLabel = profile.watchedRepos && profile.watchedRepos.length > 0 ? `${profile.watchedRepos.length} repos` : "None";
    const newsLabel = newsTopics.length > 0 ? `${newsTopics.slice(0, 3).join(", ")}${newsTopics.length > 3 ? "…" : ""}` : "Not Set";

    const keyboard = new InlineKeyboard()
        .text("🧭 Essentials", "settings:noop").row()
        .text(`🧠 AI Provider: ${aiDisplay}`, "settings:toggle_ai").text("❓", "help:ai").row()
        .text(`🌍 Timezone: ${user.timezone || "Not Set"}`, "settings:set_timezone").text("❓", "help:timezone").row()
        .text(`🔍 Tavily / day: ${tavilyLimit ?? "12 default"}`, "settings:set_tavily_limit").text("❓", "help:tavily").row()
        .text(`⏳ News Cadence: ${newsCadenceHours ? `${newsCadenceHours}h` : "3h default"}`, "settings:set_news_cadence").text("❓", "help:news_cadence").row()
        .text(`📰 News Topics: ${newsLabel}`, "settings:set_news_topics").text("❓", "help:news_topics").row()
        .text(`☀️ Weather: ${weatherLoc ? weatherLoc : "Not Set"}`, "settings:set_weather").text("❓", "help:weather").row()
        .text(`🌙 Quiet Hours`, "settings:set_quiet_hours").text("❓", "help:quiet_hours").row()
        .text(`🔇 Master Quiet: ${(profile.prefs as any)?.quietAll ? "ON" : "OFF"}`, "settings:toggle_quiet_master").text("❓", "help:quiet_master").row()
        .text(`📰 News: ${newsEnabled ? "ON" : "OFF"}`, "settings:toggle_news").row()
        .text(`📅 Habits Nudger: ${habitsEnabled ? "ON" : "OFF"}`, "settings:toggle_habits").row()
        .text(`🧭 Vibe Check: ${vibeEnabled ? "ON" : "OFF"}`, "settings:toggle_vibe").row()
        .text(`🛒 Deals: ${dealsEnabled ? "ON" : "OFF"}`, "settings:toggle_deals").row()
        .text(`🤝 Network: ${networkEnabled ? "ON" : "OFF"}`, "settings:toggle_network").row()
        .text(`🛰️ Sentinel: ${sentinelEnabled ? `${sentinelInterval}m` : "OFF"}`, "settings:toggle_sentinel").row()
        .text("📣 Signals & Safety", "settings:noop").row()
        .text(`⭐ VIP List: ${vipLabel}`, "settings:set_vips").text("❓", "help:vips").row()
        .text(`📭 DM Allowlist: ${user.dm_allowlist ? "Custom" : "All/Default"}`, "settings:set_dm_allowlist").text("❓", "help:dm_allow").row()
        .text(`📣 Mention Allowlist: ${user.mention_allowlist ? "Custom" : "All/Default"}`, "settings:set_mention_allowlist").text("❓", "help:mention_allow").row()
        .text(`💓 Proactive Heartbeat: ${heartbeatStatus ? "ON" : "OFF"}`, "settings:toggle_heartbeat").text("❓", "help:heartbeat").row()
        .text(`🧘 Vibe Cadence: ${vibeLabel}`, "settings:set_vibe_freq").text("❓", "help:vibe").row()
        .text("🧵 Content & Work", "settings:noop").row()
        .text(`🧠 Content Mode: ${contentMode ? "ON" : "OFF"}`, "settings:toggle_content_mode").text("❓", "help:content_mode").row()
        .text(`💡 Content Niche: ${contentNiche ? contentNiche : "Not Set"}`, "settings:set_content_niche").text("❓", "help:content_niche").row()
        .text(`🛍️ Wishlist: ${wishlistLabel}`, "settings:set_wishlist").text("❓", "help:wishlist").row()
        .text(`🛠️ GitHub Repos: ${reposLabel}`, "settings:set_repos").text("❓", "help:repos").row()
        .text("ℹ️ Settings Guide", "settings:help").row();

    return keyboard;
}

function buildUsageSummary(profile: any, timezone?: string | null): string {
    const prefs = (profile?.prefs || {}) as Record<string, any>;
    const usage = (prefs.usage ?? {}) as Record<string, any>;
    const today = getLocalDayKey(timezone ?? profile?.timezone ?? null);
    const tavilyCount = usage.tavily?.day === today ? usage.tavily.count ?? 0 : 0;
    const xDayCount = usage.x?.day === today ? usage.x.count ?? 0 : 0;
    const tavilyLimit = prefs.tavilyDailyLimit ?? DEFAULT_TAVILY_DAILY_MAX;
    const xLimit = prefs.xHourlyLimit ?? DEFAULT_X_HOURLY_MAX;
    return `Usage today - Tavily: ${tavilyCount}/${tavilyLimit}; X: ${xDayCount} (hourly cap ${xLimit}).`;
}

/**
 * Handles the /settings command
 */
export async function handleSettingsCommand(ctx: BotContext) {
    const telegramId = ctx.from!.id;
    try {
        const user = await getUser(telegramId);
        const profile = await getUserProfile(telegramId);
        const keyboard = await buildSettingsKeyboard(telegramId);
        const usageLine = buildUsageSummary(profile, user?.timezone ?? profile.timezone);

        // Always remind them of Voice context
        const voiceStatus = ctx.session.voiceEnabled ? "ON 🎙️" : "OFF 🔇";

        await ctx.reply(
            `⚙️ *Xclaw Settings*\n\n` +
            `Use the buttons below to configure your preferences.\n${usageLine}\n\n` +
            `_Note: Voice Replies are currently ${voiceStatus}. Toggle via /voice_\n`,
            {
                parse_mode: "Markdown",
                reply_markup: keyboard
            }
        );
    } catch (err: any) {
        await ctx.reply(`❌ Could not load settings. Are you logged in? (/setup)`);
    }
}

/**
 * Handles inline button clicks from the settings menu
 */
export async function handleSettingsCallback(ctx: BotContext, data: string) {
    const telegramId = ctx.from!.id;

    async function togglePref(key: string, label: string) {
        const profile = await getUserProfile(telegramId);
        const newPrefs = { ...(profile.prefs || {}) } as Record<string, any>;
        const currentlyOn = (newPrefs as any)[key] !== false;
        (newPrefs as any)[key] = !currentlyOn;
        await updateUserProfile(telegramId, { prefs: newPrefs });
        await ctx.answerCallbackQuery({ text: `${label} ${!currentlyOn ? "enabled" : "disabled"}.` }).catch(() => { });
        const newKeyboard = await buildSettingsKeyboard(telegramId);
        await ctx.editMessageReplyMarkup({ reply_markup: newKeyboard }).catch(() => { });
    }

    async function cycleSentinel() {
        const profile = await getUserProfile(telegramId);
        const newPrefs = { ...(profile.prefs || {}) } as Record<string, any>;
        const steps = [30, 60, 120, 0];
        const currentInterval = Number(newPrefs.sentinelIntervalMins) || 30;
        const current = newPrefs.sentinelEnabled === false ? 0 : currentInterval;
        const idx = steps.findIndex((v) => v === current);
        const nextIdx = idx >= 0 ? (idx + 1) % steps.length : 1;
        const next = steps[nextIdx];

        if (next === 0) {
            newPrefs.sentinelEnabled = false;
        } else {
            newPrefs.sentinelEnabled = true;
            newPrefs.sentinelIntervalMins = next;
        }

        await updateUserProfile(telegramId, { prefs: newPrefs });
        await ctx.answerCallbackQuery({ text: next === 0 ? "Sentinel disabled" : `Sentinel every ${next}m` }).catch(() => { });
        const newKeyboard = await buildSettingsKeyboard(telegramId);
        await ctx.editMessageReplyMarkup({ reply_markup: newKeyboard }).catch(() => { });
    }

    if (data === "settings:noop") {
        await ctx.answerCallbackQuery({ text: "" }).catch(() => { });
        return;
    }

    if (data.startsWith("help:")) {
        await ctx.answerCallbackQuery().catch(() => { });
        const topic = data.slice("help:".length);
        const helpText: Record<string, string> = {
            ai: "Choose which model drafts responses. Switch if replies feel off-tone.",
            timezone: "Needed so scheduled briefs and reminders fire at your local time.",
            tavily: "Daily cap for live web searches. Lower = conserve quota; higher = fresher answers.",
            news_cadence: "How often I fetch curated news. 0 disables proactive news; on-demand still works.",
            news_topics: "Topics/feeds I track when curating news.",
            weather: "Location for weather in briefs and vibe checks.",
            quiet_hours: "Block proactive pings during a window (e.g., 22-7). On-demand commands still work.",
            vips: "X handles I prioritize when scanning mentions/timeline.",
            dm_allow: "Restrict DM alerts to these handles. Clear to allow all.",
            mention_allow: "Restrict mention alerts to these handles. Clear to allow all.",
            heartbeat: "Keeps proactive features alive. Turn off to pause automation.",
            quiet_master: "Mutes all proactive pings. On-demand commands still respond.",
            vibe: "How often I check in on you.",
            content_mode: "When ON, I draft content and ideas proactively.",
            content_niche: "Focus area for content drafting and ideas.",
            wishlist: "Items to watch for deals/price drops.",
            repos: "GitHub repos to watch for activity.",
            guide: "Quick overview of all settings.",
        };
        const msg = helpText[topic] ?? "Quick tips not found for this setting.";
        await ctx.reply(`ℹ️ ${msg}`, { parse_mode: "Markdown" });
        if (topic === "guide") return;
        return;
    }

    if (data === "settings:help") {
        await ctx.answerCallbackQuery().catch(() => { });
        const cheatSheet =
            "*Settings Guide*\n" +
            "🧭 Essentials\n" +
            "• Timezone: Needed for correct cron times.\n" +
            "• Tavily / day: Max live web searches I’ll run for you. Lower = safer quota, higher = fresher results.\n" +
            "• News Cadence: How often I fetch curated news. 0 disables proactive news; you can still /news on-demand.\n" +
            "• News Topics: Feeds I track for you.\n" +
            "• Weather: Location for briefs and vibes.\n" +
            "• Quiet Hours: Mute proactive pings between two hours. On-demand commands still respond.\n" +
            "• Master Quiet: Mute all proactive pings until you toggle it off.\n\n" +
            "📣 Signals & Safety\n" +
            "• VIP List: X handles I watch closely.\n" +
            "• DM/Mention Allowlist: Limit alerts to these handles.\n" +
            "• Heartbeat: Keep-alive pings for proactive features.\n" +
            "• Vibe Cadence: How often to check in on you.\n\n" +
            "🧵 Content & Work\n" +
            "• Content Mode/Niche: Tailors drafts and ideas.\n" +
            "• Wishlist: Items for deal alerts.\n" +
            "• GitHub Repos: Projects to watch.";
        await ctx.reply(cheatSheet, { parse_mode: "Markdown" });
        return;
    }

    if (data === "settings:toggle_heartbeat") {
        // Toggle heartbeat script execution logic
        const { registerHeartbeat, unregisterHeartbeat, hasHeartbeatSettings } = await import("../sense/heartbeat.js");
        const isCurrentlyOn = hasHeartbeatSettings(String(telegramId));

        if (isCurrentlyOn) {
            unregisterHeartbeat(String(telegramId));
            await ctx.answerCallbackQuery({ text: "Heartbeat Disabled" });
        } else {
            registerHeartbeat(String(telegramId), telegramId);
            await ctx.answerCallbackQuery({ text: "Heartbeat Enabled" });
        }

        // Re-render keyboard
        const newKeyboard = await buildSettingsKeyboard(telegramId);
        await ctx.editMessageReplyMarkup({ reply_markup: newKeyboard }).catch(() => { });
        return;
    }

    if (data === "settings:toggle_ai") {
        const user = await getUser(telegramId);
        if (user) {
            const currentAi = user.preferred_ai || "grok";
            user.preferred_ai = currentAi === "grok" ? "gemini" : "grok";
            await upsertUser(user);
            await ctx.answerCallbackQuery({ text: `AI Provider set to ${user.preferred_ai === "grok" ? "Grok" : "Gemini"}` });

            // Re-render keyboard
            const newKeyboard = await buildSettingsKeyboard(telegramId);
            await ctx.editMessageReplyMarkup({ reply_markup: newKeyboard }).catch(() => { });
        } else {
            await ctx.answerCallbackQuery({ text: "Error: User not found." });
        }
        return;
    }

    // Handle string inputs via chat intercept
    if (data === "settings:set_timezone") {
        ctx.session.awaitingSettingInput = "timezone";
        await ctx.answerCallbackQuery();
        await ctx.reply("🌍 Please type your local timezone (e.g. `America/Los_Angeles` or `PST`).", { parse_mode: "Markdown" });
        return;
    }

    if (data === "settings:set_dm_allowlist") {
        ctx.session.awaitingSettingInput = "dm_allowlist";
        await ctx.answerCallbackQuery();
        await ctx.reply("📭 Enter a comma-separated list of X handles (no @) that I should notify you about DMs from. E.g. `elonmusk, xdaily`\n\nSend `clear` to reset to default.", { parse_mode: "Markdown" });
        return;
    }

    if (data === "settings:set_mention_allowlist") {
        ctx.session.awaitingSettingInput = "mention_allowlist";
        await ctx.answerCallbackQuery();
        await ctx.reply("📣 Enter a comma-separated list of X handles (no @) that I should notify you about Mentions from.\n\nSend `clear` to reset to default.", { parse_mode: "Markdown" });
        return;
    }

    if (data === "settings:set_weather") {
        ctx.session.awaitingSettingInput = "weather";
        await ctx.answerCallbackQuery();
        await ctx.reply("☀️ Set your weather location (city or 'City, Country').\nMax 80 chars. Send `clear` to remove.", { parse_mode: "Markdown" });
        return;
    }

    if (data === "settings:toggle_content_mode") {
        const profile = await getUserProfile(telegramId);
        const newPrefs = { ...(profile.prefs || {}) } as Record<string, unknown>;
        newPrefs.contentMode = !newPrefs.contentMode;
        await updateUserProfile(telegramId, { prefs: newPrefs });
        await ctx.answerCallbackQuery({ text: `Content mode ${newPrefs.contentMode ? "enabled" : "disabled"}.` });
        const newKeyboard = await buildSettingsKeyboard(telegramId);
        await ctx.editMessageReplyMarkup({ reply_markup: newKeyboard }).catch(() => { });
        return;
    }

    if (data === "settings:set_news_cadence") {
        ctx.session.awaitingSettingInput = "news_cadence";
        await ctx.answerCallbackQuery();
        await ctx.reply("⏳ How often should I fetch curated news? Enter hours as a number (e.g., `3`). Send `0` to disable proactive news.", { parse_mode: "Markdown" });
        return;
    }

    if (data === "settings:toggle_quiet_master") {
        const profile = await getUserProfile(telegramId);
        const newPrefs = { ...(profile.prefs || {}) } as Record<string, unknown>;
        const next = !(newPrefs as any).quietAll;
        (newPrefs as any).quietAll = next;
        await updateUserProfile(telegramId, { prefs: newPrefs });
        await ctx.answerCallbackQuery({ text: `Master quiet ${next ? "enabled" : "disabled"}.` }).catch(() => { });
        const newKeyboard = await buildSettingsKeyboard(telegramId);
        await ctx.editMessageReplyMarkup({ reply_markup: newKeyboard }).catch(() => { });
        return;
    }

    if (data === "settings:set_quiet_hours") {
        ctx.session.awaitingSettingInput = "quiet_hours";
        await ctx.answerCallbackQuery();
        await ctx.reply("🌙 Set quiet hours as `start-end` in 24h time (e.g., `22-7`). I’ll pause proactive pings in that window. Send `off` to disable.", { parse_mode: "Markdown" });
        return;
    }

    if (data === "settings:set_tavily_limit") {
        ctx.session.awaitingSettingInput = "tavily_limit";
        await ctx.answerCallbackQuery();
        await ctx.reply("🔍 Set your daily Tavily search cap (1–50). Higher caps allow more live searches but may exhaust your quota faster.", { parse_mode: "Markdown" });
        return;
    }

    if (data === "settings:set_vips") {
        ctx.session.awaitingSettingInput = "vip_list";
        await ctx.answerCallbackQuery();
        await ctx.reply("⭐ Enter comma-separated X handles (no @) for your VIP list. I’ll prioritize them in Sentinel. Send `clear` to empty.", { parse_mode: "Markdown" });
        return;
    }

    if (data === "settings:set_vibe_freq") {
        ctx.session.awaitingSettingInput = "vibe_freq";
        await ctx.answerCallbackQuery();
        await ctx.reply("🧘 How often should I run a vibe check? Enter days as a number (e.g., `3`).", { parse_mode: "Markdown" });
        return;
    }

    if (data === "settings:set_wishlist") {
        ctx.session.awaitingSettingInput = "wishlist";
        await ctx.answerCallbackQuery();
        await ctx.reply("🛍️ Enter wishlist items, comma-separated. Optional target price after a colon.\nExample: `noise-cancelling headphones:200, monitor:150`\nSend `clear` to empty.", { parse_mode: "Markdown" });
        return;
    }

    if (data === "settings:set_repos") {
        ctx.session.awaitingSettingInput = "repos";
        await ctx.answerCallbackQuery();
        await ctx.reply("🛠️ Enter GitHub repos to watch (owner/repo), comma-separated. Send `clear` to empty.", { parse_mode: "Markdown" });
        return;
    }

    if (data === "settings:set_content_niche") {
        ctx.session.awaitingSettingInput = "content_niche";
        await ctx.answerCallbackQuery();
        await ctx.reply("💡 Set your content niche (e.g., 'AI agents for creators').", { parse_mode: "Markdown" });
        return;
    }

    if (data === "settings:set_news_topics") {
        ctx.session.awaitingSettingInput = "news_topics";
        await ctx.answerCallbackQuery();
        await ctx.reply("📰 Enter topics or feeds (comma-separated) for your curated news. Example: `AI agents, indie hacking, Phoenix tech`\nSend `clear` to remove.", { parse_mode: "Markdown" });
        return;
    }

    if (data === "settings:toggle_news") {
        await togglePref("newsEnabled", "News");
        return;
    }

    if (data === "settings:toggle_habits") {
        await togglePref("habitsEnabled", "Habits nudger");
        return;
    }

    if (data === "settings:toggle_vibe") {
        await togglePref("vibeEnabled", "Vibe check");
        return;
    }

    if (data === "settings:toggle_deals") {
        await togglePref("dealsEnabled", "Deals & price alerts");
        return;
    }

    if (data === "settings:toggle_network") {
        await togglePref("networkEnabled", "Network booster");
        return;
    }

    if (data === "settings:toggle_sentinel") {
        await cycleSentinel();
        return;
    }

    await ctx.answerCallbackQuery(); // acknowledge unknown
}

/**
 * Intercepts text messages if the user is currently typing a setting
 * Returns true if intercepted, false if the message should pass to the AI
 */
export async function handleSettingTextInput(ctx: BotContext, text: string): Promise<boolean> {
    const settingType = ctx.session.awaitingSettingInput;
    if (!settingType) return false;

    const telegramId = ctx.from!.id;
    const user = await getUser(telegramId);
    const profile = await getUserProfile(telegramId);

    if (!user || !profile) {
        ctx.session.awaitingSettingInput = undefined;
        return false;
    }

    try {
        if (settingType === "timezone") {
            const normalized = normalizeTimeZoneOrNull(text);
            if (!normalized) throw new Error("Invalid timezone. Use an IANA zone like America/New_York.");
            user.timezone = normalized;
            await upsertUser(user);
            await updateUserProfile(telegramId, { timezone: normalized });
            await ctx.reply(`✅ Timezone updated to \`${user.timezone}\`.`, { parse_mode: "Markdown" });
        }
        else if (settingType === "dm_allowlist") {
            user.dm_allowlist = text.trim().toLowerCase() === "clear" ? null : text.trim();
            await upsertUser(user);
            await ctx.reply(`✅ DM Allowlist updated.`, { parse_mode: "Markdown" });
        }
        else if (settingType === "mention_allowlist") {
            user.mention_allowlist = text.trim().toLowerCase() === "clear" ? null : text.trim();
            await upsertUser(user);
            await ctx.reply(`✅ Mention Allowlist updated.`, { parse_mode: "Markdown" });
        }
        else if (settingType === "weather") {
            const trimmed = text.trim();
            const newPrefs = { ...(profile.prefs || {}) } as Record<string, unknown>;
            if (trimmed.toLowerCase() === "clear") {
                delete (newPrefs as any).weatherLocation;
            } else {
                if (trimmed.length > 80) throw new Error("Location too long.");
                (newPrefs as any).weatherLocation = trimmed;
            }
            await updateUserProfile(telegramId, { prefs: newPrefs });
            await ctx.reply(`✅ Weather location ${trimmed.toLowerCase() === "clear" ? "cleared" : "set"}.`, { parse_mode: "Markdown" });
        }
        else if (settingType === "vip_list") {
            const trimmed = text.trim();
            const list = trimmed.toLowerCase() === "clear"
                ? []
                : trimmed.split(",").map((h) => h.trim()).filter(Boolean);
            await updateUserProfile(telegramId, { vipList: list });
            await ctx.reply(`✅ VIP list ${list.length ? "updated" : "cleared"}.`, { parse_mode: "Markdown" });
        }
        else if (settingType === "vibe_freq") {
            const num = parseInt(text.trim(), 10);
            if (Number.isNaN(num) || num <= 0 || num > 30) throw new Error("Enter days between 1 and 30.");
            await updateUserProfile(telegramId, { vibeCheckFreqDays: num });
            await ctx.reply(`✅ Vibe check cadence set to every ${num} day(s).`, { parse_mode: "Markdown" });
        }
        else if (settingType === "wishlist") {
            const trimmed = text.trim();
            const entries = trimmed.toLowerCase() === "clear"
                ? []
                : trimmed.split(",").map((raw) => raw.trim()).filter(Boolean).map((raw) => {
                    const [itemPart, pricePart] = raw.split(":");
                    const item = itemPart.trim();
                    const price = pricePart ? Number(pricePart.replace(/[^0-9.]/g, "")) : undefined;
                    return pricePart && Number.isFinite(price) ? { item, targetPrice: price } : { item };
                });
            await updateUserProfile(telegramId, { wishlist: entries });
            await ctx.reply(`✅ Wishlist ${entries.length ? "updated" : "cleared"}.`, { parse_mode: "Markdown" });
        }
        else if (settingType === "repos") {
            const trimmed = text.trim();
            const repos = trimmed.toLowerCase() === "clear"
                ? []
                : trimmed.split(",").map((r) => r.trim()).filter(Boolean);
            await updateUserProfile(telegramId, { watchedRepos: repos });
            await ctx.reply(`✅ Watched repos ${repos.length ? "updated" : "cleared"}.`, { parse_mode: "Markdown" });
        }
        else if (settingType === "content_niche") {
            const trimmed = text.trim();
            const newPrefs = { ...(profile.prefs || {}) } as Record<string, unknown>;
            newPrefs.contentNiche = trimmed;
            await updateUserProfile(telegramId, { prefs: newPrefs });
            await ctx.reply(`✅ Content niche set to "${trimmed}".`, { parse_mode: "Markdown" });
        }
        else if (settingType === "news_topics") {
            const trimmed = text.trim();
            const newPrefs = { ...(profile.prefs || {}) } as Record<string, unknown>;
            if (trimmed.toLowerCase() === "clear") {
                delete (newPrefs as any).newsTopics;
            } else {
                const topics = trimmed.split(",").map((t) => t.trim()).filter(Boolean);
                (newPrefs as any).newsTopics = topics;
            }
            await updateUserProfile(telegramId, { prefs: newPrefs });
            await ctx.reply(`✅ News topics ${trimmed.toLowerCase() === "clear" ? "cleared" : "updated"}.`, { parse_mode: "Markdown" });
        }
        else if (settingType === "news_cadence") {
            const num = parseInt(text.trim(), 10);
            if (Number.isNaN(num) || num < 0 || num > 48) throw new Error("Enter hours between 0 and 48 (0 disables).");
            const newPrefs = { ...(profile.prefs || {}) } as Record<string, unknown>;
            (newPrefs as any).newsFetchIntervalHours = num;
            await updateUserProfile(telegramId, { prefs: newPrefs });
            await ctx.reply(`✅ News cadence set to ${num === 0 ? "disabled" : `every ${num} hour(s)`}.`, { parse_mode: "Markdown" });
        }
        else if (settingType === "quiet_hours") {
            const trimmed = text.trim();
            const lower = trimmed.toLowerCase();
            const newPrefs = { ...(profile.prefs || {}) } as Record<string, unknown>;
            if (lower === "off" || lower === "none" || lower === "clear") {
                delete (newPrefs as any).quietHoursStart;
                delete (newPrefs as any).quietHoursEnd;
                await updateUserProfile(telegramId, { prefs: newPrefs });
                await ctx.reply("✅ Quiet hours disabled.", { parse_mode: "Markdown" });
            } else {
                const match = trimmed.match(/^(\d{1,2})\s*[-:]?\s*(\d{1,2})$/);
                if (!match) throw new Error("Format must be start-end in 24h, e.g., 22-7.");
                const start = Number(match[1]);
                const end = Number(match[2]);
                if (start < 0 || start > 23 || end < 0 || end > 23) throw new Error("Hours must be 0-23.");
                (newPrefs as any).quietHoursStart = start;
                (newPrefs as any).quietHoursEnd = end;
                await updateUserProfile(telegramId, { prefs: newPrefs });
                await ctx.reply(`✅ Quiet hours set: ${start}:00 to ${end}:00 (24h).`, { parse_mode: "Markdown" });
            }
        }
        else if (settingType === "tavily_limit") {
            const num = parseInt(text.trim(), 10);
            if (Number.isNaN(num) || num < 1 || num > 50) throw new Error("Enter a daily limit between 1 and 50.");
            const newPrefs = { ...(profile.prefs || {}) } as Record<string, unknown>;
            (newPrefs as any).tavilyDailyLimit = num;
            await updateUserProfile(telegramId, { prefs: newPrefs });
            await ctx.reply(`✅ Tavily daily cap set to ${num} searches.`, { parse_mode: "Markdown" });
        }
    } catch (err: any) {
        await ctx.reply(`❌ Failed to save setting: ${err.message}`);
    }

    // Clear the state
    ctx.session.awaitingSettingInput = undefined;

    // Optionally resend the menu so they can see the change
    await handleSettingsCommand(ctx);

    return true; // We handled it, don't pass to AI
}
