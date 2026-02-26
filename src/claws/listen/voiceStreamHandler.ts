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

        // 1. Connect to OpenAI Realtime
        const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";
        const openAiWs = new WebSocket(url, {
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
            const realtimeTools = openAiTools.map(t => ({
                type: "function",
                name: t.function.name,
                description: t.function.description || "",
                parameters: t.function.parameters
            }));

            const sessionUpdate = {
                type: "session.update",
                session: {
                    turn_detection: { type: "server_vad" }, // Auto voice-activity detection
                    input_audio_format: "g711_ulaw",       // Native Twilio format
                    output_audio_format: "g711_ulaw",      // Native Twilio format
                    voice: "ash",                          // Pick a cool voice
                    instructions: systemInstructions,
                    modalities: ["text", "audio"],
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

        // 3. Handle incoming Audio from OpenAI -> send to Twilio
        openAiWs.on("message", async (data: WebSocket.RawData) => {
            try {
                const response = JSON.parse(data.toString());

                // Debug log any errors from OpenAI
                if (response.type === "error") {
                    console.error("[twilio] OpenAI sent an error:", JSON.stringify(response.error));
                }

                if (response.type === "response.audio.delta" && response.delta) {
                    if (streamSid) {
                        const audioDelta = {
                            event: "media",
                            streamSid: streamSid,
                            media: { payload: response.delta }
                        };
                        twilioWs.send(JSON.stringify(audioDelta));
                    }
                }

                // Handle interrupts
                if (response.type === "input_audio_buffer.speech_started") {
                    console.log("[twilio] Speech started - interrupting AI");
                    if (streamSid) {
                        twilioWs.send(JSON.stringify({
                            event: "clear",
                            streamSid: streamSid
                        }));
                    }
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
        });

        twilioWs.on("error", (error) => {
            console.error("[twilio] WebSocket error:", error);
        });
    });
}
