import { Server as WsServer } from "ws";
import WebSocket from "ws";
import { mulaw } from "alawmulaw";
import { Server } from "http";
import { config } from "../../config";
import { getCorePrompt } from "../archive/corePrompt";
import { listAllUsers } from "../../db/userStore";
import { registry } from "../wire/tools/registry";
import { translateTools } from "../wire/grok";

// Hardcoded for now, or we could look it up from DB if we want multi-tenant phone calls
const DEFAULT_USER_ID = "8026718163";

export function setupTwilioWebSocket(server: Server) {
    const wss = new WsServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
        const { pathname } = new URL(request.url || "", `http://${request.headers.host}`);
        if (pathname === "/twilio/stream") {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit("connection", ws, request);
            });
        } else {
            socket.destroy();
        }
    });

    wss.on("connection", async (twilioWs) => {
        console.log("[twilio] New WebSocket connection from Twilio");

        if (!config.OPENAI_API_KEY) {
            console.error("[twilio] OPENAI_API_KEY is not set. Cannot run Live Voice.");
            twilioWs.close();
            return;
        }

        let streamSid: string | null = null;

        // --- INWORLD TTS STREAMING STATE ---
        let textBuffer = "";
        let sentenceQueue: string[] = [];
        let audioBuffer = Buffer.alloc(0); // Unified buffer for raw MULAW
        let isProcessingQueue = false;
        let ttsAbortController = new AbortController();
        let playbackActive = false;
        let lastPacketTime = 0;

        /**
         * The Audio Worker: Pulls packets from itemQueue and sends to Twilio at exactly 20ms intervals.
         * Ensures no gaps between sentences and no overlapping audio.
         */
        function startPlaybackLoop() {
            if (playbackActive || !streamSid) return;
            playbackActive = true;
            console.log("[tts] Starting playback loop");

            const PACKET_SIZE = 160;

            // Start burst: Send 3 packets (60ms) if available to prime Twilio's buffer
            for (let i = 0; i < 3; i++) {
                if (audioBuffer.length >= PACKET_SIZE) {
                    const packet = audioBuffer.subarray(0, PACKET_SIZE);
                    audioBuffer = audioBuffer.subarray(PACKET_SIZE);

                    if (twilioWs.readyState === WebSocket.OPEN) {
                        twilioWs.send(JSON.stringify({
                            event: "media",
                            streamSid: streamSid as string,
                            media: { payload: packet.toString('base64') }
                        }));
                    }
                }
            }

            lastPacketTime = Date.now();
            const playNext = () => {
                if (ttsAbortController.signal.aborted) {
                    console.log("[tts] Playback aborted");
                    playbackActive = false;
                    audioBuffer = Buffer.alloc(0);
                    return;
                }

                if (audioBuffer.length >= PACKET_SIZE) {
                    const packet = audioBuffer.subarray(0, PACKET_SIZE);
                    audioBuffer = audioBuffer.subarray(PACKET_SIZE);

                    if (twilioWs.readyState === WebSocket.OPEN) {
                        twilioWs.send(JSON.stringify({
                            event: "media",
                            streamSid: streamSid as string,
                            media: { payload: packet.toString('base64') }
                        }));
                    }

                    lastPacketTime += 20;
                    setTimeout(playNext, Math.max(0, lastPacketTime - Date.now()));
                } else if (isProcessingQueue) {
                    // Buffer empty but still expecting more audio
                    setTimeout(playNext, 10);
                } else {
                    console.log("[tts] Playback finished, buffer dry");
                    playbackActive = false;
                    const silence = Buffer.alloc(PACKET_SIZE, 0xff);
                    for (let i = 0; i < 5; i++) {
                        if (twilioWs.readyState === WebSocket.OPEN) {
                            twilioWs.send(JSON.stringify({
                                event: 'media',
                                streamSid: streamSid as string,
                                media: { payload: silence.toString('base64') }
                            }));
                        }
                    }
                }
            };

            playNext();
        }

        async function streamSentenceToInworld(sentence: string) {
            console.log(`[tts] Synthesizing: "${sentence}"`);
            const url = "https://api.inworld.ai/tts/v1/voice:stream";
            const requestData: any = {
                text: sentence,
                voiceId: config.INWORLD_VOICE_ID || "Hades",
                modelId: "inworld-tts-1.5-mini",
                audioConfig: {
                    audioEncoding: "LINEAR16",
                    sampleRateHertz: 8000
                }
            };

            try {
                const response = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Basic ${config.INWORLD_API_KEY}`
                    },
                    body: JSON.stringify(requestData),
                    signal: ttsAbortController.signal
                });

                if (!response.ok) {
                    console.error("[inworld-tts] stream error", response.status, await response.text());
                    return;
                }

                if (!response.body) return;

                const decoder = new TextDecoder();
                let buffer = "";

                for await (const chunk of (response.body as any)) {
                    buffer += decoder.decode(chunk, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const data = JSON.parse(line);
                            if (data.audioContent) {
                                let bin = Buffer.from(data.audioContent, 'base64');

                                if (bin.toString('ascii', 0, 4) === 'RIFF') {
                                    bin = bin.subarray(44);
                                }

                                if (bin.length > 0) {
                                    // Ensure even alignment for PCM16 conversion
                                    const paddedLen = bin.length - (bin.length % 2);
                                    const pcm16 = new Int16Array(
                                        bin.buffer,
                                        bin.byteOffset,
                                        paddedLen / 2
                                    );
                                    const mulawBytes = Buffer.from(mulaw.encode(pcm16));
                                    audioBuffer = Buffer.concat([audioBuffer, mulawBytes]);
                                    startPlaybackLoop();
                                }
                            }
                        } catch (e) { }
                    }
                }

            } catch (err: any) {
                if (err.name !== 'AbortError') {
                    console.error("[inworld-tts] stream failed", err);
                }
            }
        }

        async function processSentenceQueue() {
            if (isProcessingQueue) return;
            isProcessingQueue = true;

            while (sentenceQueue.length > 0) {
                const sentence = sentenceQueue.shift();
                if (sentence) {
                    await streamSentenceToInworld(sentence);
                }
            }

            isProcessingQueue = false;
        }

        function extractSentencesAndQueue() {
            // Delimit by period, exclamation, question mark, or comma (for faster turnaround)
            const match = textBuffer.match(/.*?(?:[.!?]+|\n+|,|\s{2,})[\s]*/g);
            if (match) {
                for (const s of match) {
                    const clean = s.trim();
                    if (clean.length > 5) { // Avoid tiny 1-2 char fragments after commas
                        sentenceQueue.push(clean);
                    }
                }
                processSentenceQueue();
                textBuffer = textBuffer.replace(/.*?(?:[.!?]+|\n+|,|\s{2,})[\s]*/g, '');
            }
        }
        // --- END INWORLD TTS STATE ---


        // 1. Connect to OpenAI Realtime
        const openAiUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";
        const openAiWs = new WebSocket(openAiUrl, {
            headers: {
                "Authorization": `Bearer ${config.OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        openAiWs.on("open", async () => {
            console.log("[twilio] Connected to OpenAI Realtime API");

            // 2. Fetch context and inject System Prompt alongside translated Tools
            const systemInstructions = await getCorePrompt(DEFAULT_USER_ID);
            const openAiTools = translateTools(registry.toGeminiTools()) || [];

            // The Realtime API expects a flat tool structure, unlike the Chat Completions API
            const realtimeTools = openAiTools.map((t: any) => ({
                type: "function",
                name: t.function.name,
                description: t.function.description || "",
                parameters: t.function.parameters
            }));

            const sessionUpdate = {
                type: "session.update",
                session: {
                    turn_detection: { type: "server_vad" }, // Auto voice-activity detection
                    input_audio_format: "g711_ulaw",       // Native Twilio format for input
                    // Output modality changed to text only since we use Inworld TTS payload.
                    modalities: ["text"],
                    instructions: systemInstructions,
                    temperature: 0.7,
                    tools: realtimeTools
                }
            };
            openAiWs.send(JSON.stringify(sessionUpdate));

            // Force the AI to speak first so it says "Hello!" when they answer
            openAiWs.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "Answer the phone with a short greeting." }]
                }
            }));
            openAiWs.send(JSON.stringify({ type: "response.create" }));
        });

        // 3. Handle incoming Audio/Text from OpenAI -> send to Twilio
        openAiWs.on("message", async (data: WebSocket.RawData) => {
            try {
                const response = JSON.parse(data.toString());

                // Debug log any errors from OpenAI
                if (response.type === "error") {
                    console.error("[twilio] OpenAI sent an error:", JSON.stringify(response.error));
                }

                // Handle incoming text delta for TTS
                if (response.type === "response.text.delta" && response.delta) {
                    textBuffer += response.delta;
                    extractSentencesAndQueue();
                }

                if (response.type === "response.done") {
                    // flush any remaining text
                    if (textBuffer.trim().length > 0) {
                        sentenceQueue.push(textBuffer.trim());
                        textBuffer = "";
                        processSentenceQueue();
                    }
                }

                // Handle interrupts
                if (response.type === "input_audio_buffer.speech_started") {
                    console.log("[twilio] Speech started - interrupting AI");

                    // Stop Inworld TTS
                    ttsAbortController.abort();
                    ttsAbortController = new AbortController();
                    sentenceQueue = [];
                    audioBuffer = Buffer.alloc(0);
                    textBuffer = "";
                    playbackActive = false;
                    isProcessingQueue = false;

                    // Also clear Twilio buffer
                    if (streamSid) {
                        twilioWs.send(JSON.stringify({
                            event: "clear",
                            streamSid: streamSid
                        }));
                    }

                    // Instruct OpenAI to truncate the active generation if any
                    // The realtime model drops the current response on its own when input speech starts using server_vad, but we log the reset on our side.
                }

                // Handle Tool Calls from OpenAI Realtime
                if (response.type === "response.function_call_arguments.done") {
                    console.log(`[twilio] OpenAI requested tool: ${response.name}`);
                    let args = {};
                    try {
                        args = JSON.parse(response.arguments);
                    } catch (e) {
                        console.error("[twilio] Failed to parse tool args", e);
                    }

                    // Execute tool locally
                    const resultStr = await registry.dispatch(response.name, args, { userId: DEFAULT_USER_ID });

                    // Send result back to OpenAI
                    openAiWs.send(JSON.stringify({
                        type: "conversation.item.create",
                        item: {
                            type: "function_call_output",
                            call_id: response.call_id,
                            output: resultStr
                        }
                    }));

                    // Force OpenAI to read the result out loud
                    openAiWs.send(JSON.stringify({ type: "response.create" }));
                }
            } catch (err) {
                console.error("[twilio] Error processing OpenAI message:", err);
            }
        });

        openAiWs.on("error", (err) => console.error("[twilio] OpenAI WS Error:", err));
        openAiWs.on("close", () => console.log("[twilio] OpenAI WS Closed"));

        // 4. Handle incoming Audio from Twilio -> send to OpenAI
        twilioWs.on("message", (message: WebSocket.RawData) => {
            try {
                const data = JSON.parse(message.toString());

                if (data.event === "start") {
                    streamSid = data.start.streamSid;
                    console.log(`[twilio] incoming stream started: ${streamSid}`);
                } else if (data.event === "media") {
                    if (openAiWs.readyState === WebSocket.OPEN) {
                        const audioAppend = {
                            type: "input_audio_buffer.append",
                            audio: data.media.payload
                        };
                        openAiWs.send(JSON.stringify(audioAppend));
                    }
                } else if (data.event === "stop") {
                    console.log(`[twilio] stream stopped`);
                    openAiWs.close();
                }
            } catch (err) {
                console.error("[twilio] Error processing Twilio message:", err);
            }
        });

        twilioWs.on("close", () => {
            console.log("[twilio] WebSocket closed");
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.close();
            }
            ttsAbortController.abort();
        });

        twilioWs.on("error", (error) => {
            console.error("[twilio] WebSocket error:", error);
        });
    });
}
