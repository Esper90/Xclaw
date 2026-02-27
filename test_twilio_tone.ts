import { mulaw } from 'alawmulaw';
import WebSocket from 'ws';
import { config } from './src/config';

// Synthetic 440 Hz tone generator for Twilio verification
function generateMulawTone(durationMs: number, freq: number = 440): Buffer {
    const sampleRate = 8000;
    const numSamples = Math.floor(sampleRate * durationMs / 1000);
    const pcm = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        // 0.4 amplitude to avoid clipping
        pcm[i] = Math.floor(32767 * Math.sin(2 * Math.PI * freq * t) * 0.4);
    }
    // Convert to exactly what Twilio expects: raw mu-law bytes
    return Buffer.from(mulaw.encode(pcm));
}

async function sendToneToTwilio(streamSid: string, twilioWsUrl: string) {
    const ws = new WebSocket(twilioWsUrl);

    ws.on('open', () => {
        console.log("Connected to Twilio Stream for Tone Test");
        const toneData = generateMulawTone(5000, 440); // 5 second beep

        const PACKET_SIZE = 160;
        let offset = 0;
        const startTime = Date.now();

        const sendNext = () => {
            if (offset >= toneData.length) {
                console.log("Tone Finished");
                ws.close();
                return;
            }

            const chunk = toneData.subarray(offset, offset + PACKET_SIZE);
            ws.send(JSON.stringify({
                event: 'media',
                streamSid: streamSid,
                media: { payload: chunk.toString('base64') }
            }));

            offset += PACKET_SIZE;
            const nextTime = startTime + (offset / 8);
            setTimeout(sendNext, Math.max(0, nextTime - Date.now()));
        };

        sendNext();
    });

    ws.on('error', (err) => console.error("WS Error:", err));
}

// NOTE: This can only be run if we have a way to inject it into an active call.
// Instead, let's modify the voiceStreamHandler.ts to trigger this on a special command or just run it.
console.log("To run this, modify voiceStreamHandler.ts to call generateMulawTone() on open.");
