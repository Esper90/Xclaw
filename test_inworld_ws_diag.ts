import * as dotenv from 'dotenv';
import WebSocket from 'ws';
import { mulaw } from 'alawmulaw';
import * as fs from 'fs';

dotenv.config();

let rawKey = process.env.INWORLD_API_KEY || "";
rawKey = rawKey.replace(/[\r\n"']/g, '').trim();

async function runDiagnostic() {
    console.log("Connecting to Inworld Bidirectional WebSocket...");

    // Auth is Basic (apiKey:apiSecret) encoded in base64. 
    // We already have the full base64 string in rawKey.
    const url = "wss://api.inworld.ai/tts/v1/voice:streamBidirectional";

    const ws = new WebSocket(url, {
        headers: {
            "Authorization": `Basic ${rawKey}`
        }
    });

    let receivedAudio = Buffer.alloc(0);

    ws.on('open', () => {
        console.log("WebSocket Connected!");

        // Send the synthesis request
        const request = {
            voiceId: "Hades",
            audioConfig: {
                audioEncoding: "LINEAR16",
                sampleRateHertz: 8000
            },
            textWait: {
                text: "Hello! Testing the bidirectional stream. Can you hear me?"
            }
        };
        ws.send(JSON.stringify(request));
        console.log("Request sent:", JSON.stringify(request));
    });

    ws.on('message', (data) => {
        try {
            const response = JSON.parse(data.toString());
            console.log("Received message type:", response.type || "audio_chunk");

            if (response.audioContent) {
                const chunk = Buffer.from(response.audioContent, 'base64');
                receivedAudio = Buffer.concat([receivedAudio, chunk]);
                console.log(`  Received chunk: ${chunk.length} bytes`);
            }

            // If it's a finish message or something similar
            if (response.type === 'RESPONSE_TYPE_FINAL') {
                console.log("Conversion Finished.");
                finalize();
            }
        } catch (e) {
            console.error("Failed to parse message", e);
        }
    });

    ws.on('error', (err) => {
        console.error("WS Error:", err);
    });

    ws.on('close', (code, reason) => {
        console.log(`WS Closed: ${code} - ${reason}`);
        finalize();
    });

    function finalize() {
        if (receivedAudio.length > 0) {
            console.log(`Total Audio Received: ${receivedAudio.length} bytes`);
            // The audioContent is usually wrapped in WAV headers if it was requested as such,
            // but for streamBidirectional, we'll see if it's raw PCM or WAV.
            fs.writeFileSync('./debug_ws_hades.raw', receivedAudio);
            console.log("Saved to ./debug_ws_hades.raw");
        } else {
            console.log("No audio received.");
        }
        process.exit(0);
    }

    // Timeout safety
    setTimeout(() => {
        console.log("Timeout reached.");
        finalize();
    }, 10000);
}

runDiagnostic();
