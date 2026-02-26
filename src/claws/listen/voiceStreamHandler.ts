import { Server as WsServer } from "ws";
import WebSocket from "ws";
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
        let isSynthesizing = false;
        let ttsAbortController = new AbortController();

        async function streamSentenceToInworld(sentence: string) {
            const url = "https://api.inworld.ai/v2/tts:synthesize-speech";
            const requestData: any = {
                text: sentence,
                voiceId: config.INWORLD_VOICE_ID || "Hades",
                audioConfig: {
                    audioEncoding: "MULAW",
                    sampleRateHertz: 8000
                }
            };


            // For now, let's request "PCMU" or "MULAW" if Inworld supports it (Google TTS does).
            // Actually, Inworld's underlying Google TTS engine supports "MULAW".
            // Let's request MULAW.
            requestData.audioConfig.audioEncoding = "MULAW";

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
                    console.error("[inworld-tts] fetch error", response.status, await response.text());
                    return;
                }

                if (!response.body) return;

                // Accumulate the entire WAV response from this sentence (Inworld V2 streams it very quickly)
                const reader = response.body.getReader();
                let fullResponse = Buffer.alloc(0);

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    fullResponse = Buffer.concat([fullResponse, Buffer.from(value)]);
                }

                // Dynamically extract the pure MULAW bytes from the WAV container.
                // MULAW 'fact' chunks often make the header 58+ bytes instead of the standard 44.
                function extractRawAudioFromWav(buffer: Buffer): Buffer {
                    let offset = 12; // Skip 'RIFF' + total size + 'WAVE'
                    while (offset + 8 <= buffer.length) {
                        const chunkId = buffer.toString('ascii', offset, offset + 4);
                        const chunkSize = buffer.readUInt32LE(offset + 4);
                        if (chunkId === 'data') {
                            return buffer.subarray(offset + 8, offset + 8 + chunkSize);
                        }
                        offset += 8 + chunkSize + (chunkSize % 2); // Pad to even byte boundary
                    }
                    // Fallback to naive 44-byte header if 'data' chunk is somehow missing
                    return buffer.subarray(44);
                }

                const rawMulaw = extractRawAudioFromWav(fullResponse);

                // Twilio loves small, paced packets (usually 20ms = 160 bytes for 8000Hz 8-bit).
                // Burst-dumping the entire array at once causes Twilio to mute the connection.
                if (streamSid) {
                    const PACKET_SIZE = 160;
                    let offset = 0;

                    const sendNextPacket = () => {
                        // Stop playing this sentence if the user just interrupted
                        if (ttsAbortController.signal.aborted) return;
                        if (offset >= rawMulaw.length) return;

                        const chunk = rawMulaw.subarray(offset, Math.min(offset + PACKET_SIZE, rawMulaw.length));
                        if (twilioWs.readyState === WebSocket.OPEN) {
                            twilioWs.send(JSON.stringify({
                                event: "media",
                                streamSid: streamSid,
                                media: { payload: chunk.toString('base64') }
                            }));
                        }

                        offset += PACKET_SIZE;
                        setTimeout(sendNextPacket, 20); // 20ms real-time pacing
                    };

                    sendNextPacket();
                }

            } catch (err: any) {
                if (err.name === 'AbortError') {
                    console.log("[inworld-tts] stream aborted for sentence:", sentence);
                } else {
                    console.error("[inworld-tts] stream failed", err);
                }
            }
        }

        async function processSentenceQueue() {
            if (isSynthesizing) return;
            isSynthesizing = true;

            while (sentenceQueue.length > 0) {
                const sentence = sentenceQueue.shift();
                if (sentence) {
                    await streamSentenceToInworld(sentence);
                }
            }

            isSynthesizing = false;
        }

        function extractSentencesAndQueue() {
            // Split by standard sentence delimiters. Keep the delimiters with the sentence.
            const match = textBuffer.match(/.*?(?:[.!?]+|\n+)[\s]*/g);
            if (match) {
                for (const s of match) {
                    const clean = s.trim();
                    if (clean.length > 0) {
                        sentenceQueue.push(clean);
                    }
                }
                processSentenceQueue();
                textBuffer = textBuffer.replace(/.*?(?:[.!?]+|\n+)[\s]*/g, '');
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
                    textBuffer = "";
                    isSynthesizing = false;

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
