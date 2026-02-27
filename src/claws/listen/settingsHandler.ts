import { InlineKeyboard } from "grammy";
import type { BotContext } from "../connect/bot.js";
import { getUser, upsertUser } from "../../db/userStore.js";
import { hasHeartbeatSettings } from "../sense/heartbeat.js";
import { getUserProfile, updateUserProfile } from "../../db/profileStore";

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
    const vipLabel = profile.vipList && profile.vipList.length > 0 ? `${profile.vipList.length} handles` : "Not Set";
    const vibeLabel = profile.vibeCheckFreqDays ? `${profile.vibeCheckFreqDays}d` : "3d";
    const wishlistLabel = profile.wishlist && profile.wishlist.length > 0 ? `${profile.wishlist.length} items` : "Empty";
    const reposLabel = profile.watchedRepos && profile.watchedRepos.length > 0 ? `${profile.watchedRepos.length} repos` : "None";
    const newsLabel = newsTopics.length > 0 ? `${newsTopics.slice(0, 3).join(", ")}${newsTopics.length > 3 ? "…" : ""}` : "Not Set";

    const keyboard = new InlineKeyboard()
        .text("🧭 Essentials", "settings:noop").row()
        .text(`🧠 AI Provider: ${aiDisplay}`, "settings:toggle_ai").row()
        .text(`🌍 Timezone: ${user.timezone || "Not Set"}`, "settings:set_timezone").row()
        .text(`🔍 Tavily / day: ${tavilyLimit ?? "12 default"}`, "settings:set_tavily_limit").row()
        .text(`⏳ News Cadence: ${newsCadenceHours ? `${newsCadenceHours}h` : "3h default"}`, "settings:set_news_cadence").row()
        .text(`📰 News Topics: ${newsLabel}`, "settings:set_news_topics").row()
        .text(`☀️ Weather: ${weatherLoc ? weatherLoc : "Not Set"}`, "settings:set_weather").row()
        .text("📣 Signals & Safety", "settings:noop").row()
        .text(`⭐ VIP List: ${vipLabel}`, "settings:set_vips").row()
        .text(`📭 DM Allowlist: ${user.dm_allowlist ? "Custom" : "All/Default"}`, "settings:set_dm_allowlist").row()
        .text(`📣 Mention Allowlist: ${user.mention_allowlist ? "Custom" : "All/Default"}`, "settings:set_mention_allowlist").row()
        .text(`💓 Proactive Heartbeat: ${heartbeatStatus ? "ON" : "OFF"}`, "settings:toggle_heartbeat").row()
        .text(`🧘 Vibe Cadence: ${vibeLabel}`, "settings:set_vibe_freq").row()
        .text("🧵 Content & Work", "settings:noop").row()
        .text(`🧠 Content Mode: ${contentMode ? "ON" : "OFF"}`, "settings:toggle_content_mode").row()
        .text(`💡 Content Niche: ${contentNiche ? contentNiche : "Not Set"}`, "settings:set_content_niche").row()
        .text(`🛍️ Wishlist: ${wishlistLabel}`, "settings:set_wishlist").row()
        .text(`🛠️ GitHub Repos: ${reposLabel}`, "settings:set_repos").row()
        .text("ℹ️ Settings Guide", "settings:help").row();

    return keyboard;
}

/**
 * Handles the /settings command
 */
export async function handleSettingsCommand(ctx: BotContext) {
    const telegramId = ctx.from!.id;
    try {
        const keyboard = await buildSettingsKeyboard(telegramId);

        // Always remind them of Voice context
        const voiceStatus = ctx.session.voiceEnabled ? "ON 🎙️" : "OFF 🔇";

        await ctx.reply(
            `⚙️ *Xclaw Settings*\n\n` +
            `Use the buttons below to configure your preferences.\n\n` +
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

    if (data === "settings:noop") {
        await ctx.answerCallbackQuery({ text: "" }).catch(() => { });
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
            "• Weather: Location for briefs and vibes.\n\n" +
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
            user.timezone = text.trim();
            await upsertUser(user);
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
