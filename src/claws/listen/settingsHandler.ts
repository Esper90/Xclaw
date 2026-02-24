import { InlineKeyboard } from "grammy";
import type { BotContext } from "../connect/bot.js";
import { getUser, upsertUser } from "../../db/userStore.js";
import { hasHeartbeatSettings } from "../sense/heartbeat.js";

/**
 * Builds the inline keyboard for the Settings menu
 */
async function buildSettingsKeyboard(telegramId: number) {
    const user = await getUser(telegramId);
    if (!user) {
        throw new Error("User not found in DB.");
    }

    // Determine Heartbeat status depending on if there's a file for them
    const heartbeatStatus = hasHeartbeatSettings(String(telegramId));

    const keyboard = new InlineKeyboard()
        .text(`🌍 Timezone: ${user.timezone || "Not Set"}`, "settings:set_timezone").row()
        .text(`💓 Proactive Heartbeat: ${heartbeatStatus ? "ON" : "OFF"}`, "settings:toggle_heartbeat").row()
        .text(`📭 DM Allowlist: ${user.dm_allowlist ? "Custom" : "All/Default"}`, "settings:set_dm_allowlist").row()
        .text(`📣 Mention Allowlist: ${user.mention_allowlist ? "Custom" : "All/Default"}`, "settings:set_mention_allowlist").row();

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

    if (!user) {
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
    } catch (err: any) {
        await ctx.reply(`❌ Failed to save setting: ${err.message}`);
    }

    // Clear the state
    ctx.session.awaitingSettingInput = undefined;

    // Optionally resend the menu so they can see the change
    await handleSettingsCommand(ctx);

    return true; // We handled it, don't pass to AI
}
