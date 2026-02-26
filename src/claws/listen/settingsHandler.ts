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
    const vipLabel = profile.vipList && profile.vipList.length > 0 ? `${profile.vipList.length} handles` : "Not Set";
    const vibeLabel = profile.vibeCheckFreqDays ? `${profile.vibeCheckFreqDays}d` : "3d";
    const wishlistLabel = profile.wishlist && profile.wishlist.length > 0 ? `${profile.wishlist.length} items` : "Empty";
    const reposLabel = profile.watchedRepos && profile.watchedRepos.length > 0 ? `${profile.watchedRepos.length} repos` : "None";

    const keyboard = new InlineKeyboard()
        .text(`🧠 AI Provider: ${aiDisplay}`, "settings:toggle_ai").row()
        .text(`🌍 Timezone: ${user.timezone || "Not Set"}`, "settings:set_timezone").row()
        .text(`💓 Proactive Heartbeat: ${heartbeatStatus ? "ON" : "OFF"}`, "settings:toggle_heartbeat").row()
        .text(`📭 DM Allowlist: ${user.dm_allowlist ? "Custom" : "All/Default"}`, "settings:set_dm_allowlist").row()
        .text(`📣 Mention Allowlist: ${user.mention_allowlist ? "Custom" : "All/Default"}`, "settings:set_mention_allowlist").row()
        .text(`☀️ Weather: ${weatherLoc ? weatherLoc : "Not Set"}`, "settings:set_weather").row()
        .text(`⭐ VIP List: ${vipLabel}`, "settings:set_vips").row()
        .text(`🧘 Vibe Cadence: ${vibeLabel}`, "settings:set_vibe_freq").row()
        .text(`🛍️ Wishlist: ${wishlistLabel}`, "settings:set_wishlist").row()
        .text(`🛠️ GitHub Repos: ${reposLabel}`, "settings:set_repos").row();

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
    } catch (err: any) {
        await ctx.reply(`❌ Failed to save setting: ${err.message}`);
    }

    // Clear the state
    ctx.session.awaitingSettingInput = undefined;

    // Optionally resend the menu so they can see the change
    await handleSettingsCommand(ctx);

    return true; // We handled it, don't pass to AI
}
