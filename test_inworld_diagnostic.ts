import * as dotenv from 'dotenv';
dotenv.config();

let rawKey = process.env.INWORLD_API_KEY || "";
rawKey = rawKey.replace(/[\r\n"']/g, '').trim();

async function test(label: string, body: any) {
    const fetch = (await import('node-fetch')).default;
    const url = 'https://api.inworld.ai/tts/v1/voice:stream';
    console.log(`\n--- Testing ${label} ---`);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Basic ${rawKey}` },
            body: JSON.stringify(body)
        });
        console.log("Status:", res.status);
        if (res.ok && res.body) {
            let chunkCount = 0;
            for await (const chunk of res.body) {
                const text = chunk.toString();
                if (text.includes("audioContent")) chunkCount++;
            }
            console.log("Audio Chunks Received:", chunkCount);
        } else {
            console.log("Error Body:", await res.text());
        }
    } catch (e) {
        console.log("Request Failed:", e);
    }
}

async function run() {
    // 1. Simple (no config)
    await test("Simple Request", {
        text: "Simple test.",
        voiceId: "Hades",
        modelId: "inworld-tts-1.5-mini"
    });

    // 2. With LINEAR16
    await test("With LINEAR16", {
        text: "Linear test.",
        voiceId: "Hades",
        modelId: "inworld-tts-1.5-mini",
        audioConfig: { audioEncoding: "LINEAR16" }
    });

    // 3. With 8000Hz
    await test("With 8000Hz", {
        text: "8k test.",
        voiceId: "Hades",
        modelId: "inworld-tts-1.5-mini",
        audioConfig: { sampleRateHertz: 8000 }
    });
}
run();
