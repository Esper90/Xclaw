import * as dotenv from 'dotenv';
dotenv.config();

let rawKey = process.env.INWORLD_API_KEY || "";
rawKey = rawKey.replace(/[\r\n"']/g, '').trim();

async function testV2API() {
    const url = "https://api.inworld.ai/v2/tts:synthesize-speech";
    const fetch = (await import('node-fetch')).default;

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Basic ${rawKey}`
        },
        body: JSON.stringify({
            text: "Hello there!",
            voiceId: "Hades",
            audioConfig: {
                audioEncoding: "MULAW",
                sampleRateHertz: 8000
            }
        })
    });

    if (res.ok) {
        const json = await res.json();
        console.log("JSON Keys:", Object.keys(json));
        if (json.audioContent) {
            console.log("Has audioContent! Length:", json.audioContent.length);
        }
    }
}
testV2API();
