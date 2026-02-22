import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { BotContext } from "../connect/bot";
import { transcribeAudio } from "../sense/whisper";
import { synthesizeToFile } from "../sense/tts";
import { handleText } from "./textHandler";
import { config } from "../../config";
import { InputFile } from "grammy";

const DOWNLOADS_DIR = path.join(os.tmpdir(), "gc-voice");

/**
 * Full voice pipeline:
 * 1. Download OGG voice file from Telegram
 * 2. Transcribe via Groq Whisper
 * 3. Run through the standard text pipeline
 * 4. Always attempt TTS reply (voice-in = voice-out by default)
 * 5. Fall back to text if TTS fails
 */
export async function handleVoice(ctx: BotContext): Promise<void> {
    const userId = String(ctx.from!.id);
    const voice = ctx.message?.voice ?? ctx.message?.audio;

    if (!voice) {
        await ctx.reply("⚠️ Could not read voice message.");
        return;
    }

    // Ensure downloads directory exists
    if (!fs.existsSync(DOWNLOADS_DIR)) {
        fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    }

    const processing = await ctx.reply("🎙️ Transcribing...");
    let oggPath: string | undefined;

    try {
        // 1. Download voice file
        const file = await ctx.api.getFile(voice.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);

        oggPath = path.join(DOWNLOADS_DIR, `${userId}-${Date.now()}.ogg`);
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(oggPath, buffer);

        // 2. Transcribe
        const transcript = await transcribeAudio(oggPath);
        if (!transcript || transcript.trim().length === 0) {
            await ctx.api.editMessageText(
                ctx.chat!.id,
                processing.message_id,
                "⚠️ Could not transcribe audio. Please try again."
            );
            return;
        }

        // 3. Run text pipeline
        await ctx.api.editMessageText(
            ctx.chat!.id,
            processing.message_id,
            `🎙️ _"${transcript}"_\n\n⏳ Thinking...`,
            { parse_mode: "Markdown" }
        );

        const replyText = await handleText(ctx, transcript);

        // 4. Always attempt TTS for voice inputs (voice-in = voice-out)
        let ttsSent = false;
        try {
            const ttsFile = await synthesizeToFile(replyText);
            await ctx.replyWithVoice(new InputFile(ttsFile), {
                caption: `🎙️ _"${transcript}"_`,
                parse_mode: "Markdown",
            });
            fs.unlinkSync(ttsFile);
            ttsSent = true;
        } catch (ttsErr) {
            console.warn(`[voiceHandler] TTS failed, falling back to text:`, ttsErr);
        }

        // 5. Always update the text message with the reply, so user can see it (esp. for drafts)
        await ctx.api.editMessageText(
            ctx.chat!.id,
            processing.message_id,
            `🎙️ _"${transcript}"_\n\n${replyText}`,
            { parse_mode: "Markdown" }
        ).catch(() => {
            // If editing fails (e.g. message already deleted), just send a new one
            if (ttsSent) return; // If voice note was sent, don't spam if edit fails
            ctx.reply(`${replyText}`);
        });
    } catch (err) {
        console.error(`[voiceHandler] Error:`, err);
        await ctx.reply("❌ Voice processing failed. Please try again.");
    } finally {
        // Cleanup downloaded file
        if (oggPath && fs.existsSync(oggPath)) {
            fs.unlinkSync(oggPath);
        }
    }
}
