import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { BotContext } from "../connect/bot";
import { summarizeDocumentForMemory } from "../sense/document";
import { upsertMemory } from "../archive/pinecone";
import { config } from "../../config";
import { recordActivity } from "../sense/activityTracker";
import { handleText } from "./textHandler";

const DOWNLOADS_DIR = path.join(os.tmpdir(), "gc-document");

/**
 * Handle incoming documents from the user (PDF, TXT, CSV, etc).
 */
export async function handleDocument(ctx: BotContext): Promise<void> {
    const userId = String(ctx.from!.id);

    recordActivity(userId);

    if (ctx.session.threadMode) {
        await ctx.reply("⚠️ Document uploads are not supported while building a thread.", { parse_mode: "Markdown" });
        return;
    }

    const document = ctx.message?.document;
    if (!document) {
        await ctx.reply("⚠️ Could not read document.");
        return;
    }

    // Telegram Bot API limit is 20MB for downloads
    if (document.file_size && document.file_size > 20 * 1024 * 1024) {
        await ctx.reply("⚠️ File is too large. Maximum supported size is 20MB.", { parse_mode: "Markdown" });
        return;
    }

    if (!fs.existsSync(DOWNLOADS_DIR)) {
        fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    }

    const userCaption = ctx.message?.caption;
    let fileName = document.file_name || "unknown_file";
    let mimeType = document.mime_type || "application/octet-stream";

    // Re-map common types if empty
    if (fileName.endsWith(".pdf")) mimeType = "application/pdf";
    if (fileName.endsWith(".txt")) mimeType = "text/plain";
    if (fileName.endsWith(".csv")) mimeType = "text/csv";

    // Supported mime types by Gemini inlineData
    const supportedMimes = ["application/pdf", "text/plain", "text/csv", "application/rtf", "text/rtf", "application/x-javascript", "text/javascript", "application/x-python", "text/x-python", "text/html"];

    if (!supportedMimes.includes(mimeType) && !mimeType.startsWith("text/")) {
        await ctx.reply(`⚠️ Unsupported file type: ${mimeType}. I currently support PDFs and text-based files.`, { parse_mode: "Markdown" });
        return;
    }


    const processingMsg = await ctx.reply(`📄 _Reading document (${fileName})..._`, {
        parse_mode: "Markdown",
        reply_parameters: { message_id: ctx.message!.message_id }
    });

    let localPath: string | undefined;

    try {
        const file = await ctx.api.getFile(document.file_id);
        if (!file.file_path) throw new Error("File path missing from Telegram API response");

        const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);

        localPath = path.join(DOWNLOADS_DIR, `${userId}-${Date.now()}-${fileName}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(localPath, buffer);

        const base64Data = buffer.toString("base64");
        console.log(`[documentHandler] Downloaded ${fileName}, size: ${base64Data.length} chars. Summarizing...`);

        const summary = await summarizeDocumentForMemory(base64Data, mimeType, fileName, userCaption);
        console.log(`[documentHandler] Summary received. Upserting to memory...`);

        const memoryText = `[User uploaded a document named ${fileName}]:\n${summary}`;
        await upsertMemory(userId, memoryText, {
            source: "document",
            fileId: document.file_id,
            fileName: fileName
        });
        console.log(`[documentHandler] Memory upserted. Triggering handleText...`);

        const syntheticTrigger = `[SYSTEM_EVENT]: User uploaded a document named "${fileName}". fileId: ${document.file_id}. Summary of contents: ${summary}`;
        const aiReply = await handleText(ctx, syntheticTrigger);

        try {
            await ctx.api.editMessageText(
                ctx.chat!.id,
                processingMsg.message_id,
                aiReply,
                { parse_mode: "Markdown" }
            );
        } catch (editErr) {
            try {
                await ctx.api.editMessageText(
                    ctx.chat!.id,
                    processingMsg.message_id,
                    aiReply
                );
            } catch (rawErr) {
                await ctx.reply(aiReply).catch(() => { });
            }
        }

    } catch (err) {
        console.error(`[documentHandler] Error:`, err);
        await ctx.api.editMessageText(
            ctx.chat!.id,
            processingMsg.message_id,
            "❌ Failed to process and save the document."
        );
    } finally {
        if (localPath && fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
        }
    }
}
