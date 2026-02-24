import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { BotContext } from "../connect/bot";
import { describePhotoForMemory } from "../sense/photo";
import { upsertMemory } from "../archive/pinecone";
import { config } from "../../config";
import { recordActivity } from "../sense/activityTracker";
import { handleText } from "./textHandler";
import { recordInteraction } from "../archive/buffer";

const DOWNLOADS_DIR = path.join(os.tmpdir(), "gc-photo");

/**
 * Handle incoming photos from the user.
 * 1. Download the highest resolution photo from Telegram
 * 2. Send it to Gemini Vision for a detailed semantic description
 * 3. Save the resulting text to Pinecone memory
 * 4. Reply with a confirmation/summary
 */
export async function handlePhoto(ctx: BotContext): Promise<void> {
    const userId = String(ctx.from!.id);

    // Track activity for butler background watcher
    recordActivity(userId);

    if (ctx.session.threadMode) {
        await ctx.reply("⚠️ Photo uploads are not supported while building a thread. Please `/finish` or `/cancelthread` first.", { parse_mode: "Markdown" });
        return;
    }

    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) {
        await ctx.reply("⚠️ Could not read photo.");
        return;
    }

    // Ensure downloads directory exists
    if (!fs.existsSync(DOWNLOADS_DIR)) {
        fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    }

    // Telegram sends multiple sizes. Grab the largest one (last item in array).
    const largestPhoto = photos[photos.length - 1];
    const userCaption = ctx.message?.caption;

    const processingMsg = await ctx.reply("📸 _Analyzing photo..._", {
        parse_mode: "Markdown",
        reply_parameters: { message_id: ctx.message!.message_id }
    });

    let localPath: string | undefined;

    try {
        // 1. Download the photo
        const file = await ctx.api.getFile(largestPhoto.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);

        localPath = path.join(DOWNLOADS_DIR, `${userId}-${Date.now()}.jpg`);
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(localPath, buffer);

        // 2. Prepare for Gemini (requires base64)
        const base64Data = buffer.toString("base64");
        const mimeType = "image/jpeg";
        console.log(`[photoHandler] Downloaded, size: ${base64Data.length} chars. Calling describePhotoForMemory...`);

        // 3. Get detailed description from Gemini 1.5 Flash
        const description = await describePhotoForMemory(base64Data, mimeType, userCaption);
        console.log(`[photoHandler] Description received. Upserting to memory...`);

        // 4. Upsert to Pinecone
        // Prefix description so it's clear it's an image in vector search
        const memoryText = `[User uploaded an image]:\n${description}`;
        await upsertMemory(userId, memoryText, {
            source: "photo",
            fileId: largestPhoto.file_id
        });
        console.log(`[photoHandler] Memory upserted. Triggering handleText...`);

        // 5. Trigger proactive AI reaction
        const syntheticTrigger = `[SYSTEM_EVENT]: User uploaded a photo. fileId: ${largestPhoto.file_id}. Description: ${description}`;
        const aiReply = await handleText(ctx, syntheticTrigger);
        console.log(`[photoHandler] handleText finished. Updating Telegram message...`);

        await ctx.api.editMessageText(
            ctx.chat!.id,
            processingMsg.message_id,
            aiReply,
            { parse_mode: "Markdown" }
        );

    } catch (err) {
        console.error(`[photoHandler] Error:`, err);
        await ctx.api.editMessageText(
            ctx.chat!.id,
            processingMsg.message_id,
            "❌ Failed to process and save the photo."
        );
    } finally {
        // Cleanup downloaded file
        if (localPath && fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
        }
    }
}
