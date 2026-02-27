const WebSocket = require('ws');
require('dotenv').config();

const rawKey = process.env.INWORLD_API_KEY || "";
console.log("Key length:", rawKey.length);
console.log("Includes colon?", rawKey.includes(':'));

// The user states headers must be Authorization: Basic <base64_key>
// If it contains a colon, we should base64 encode it. If it doesn't, maybe it's already encoded.
const authStr = rawKey.includes(':') ? Buffer.from(rawKey).toString('base64') : rawKey;
console.log("Auth string starts with:", authStr.substring(0, 10));

const urlsToTest = [
    'wss://api.inworld.ai/v1/tts:synthesize-speech-websocket',
    'wss://api.inworld.ai/tts/v1/voice:streamBidirectional'
];

function testWebSocket(url) {
    return new Promise((resolve) => {
        console.log(`\nTesting: ${url}`);
        const ws = new WebSocket(url, {
            headers: { 'Authorization': `Basic ${authStr}` }
        });

        ws.on('open', () => {
            console.log('OPENED successfully for', url);
            // send a test message
            ws.send(JSON.stringify({
                text: "Hello testing",
                voiceId: "hades",
                contextId: "test-xyz-1234",
                modelId: "inworld-tts-1.5-mini",
                audioConfig: {
                    audioEncoding: "LINEAR16",
                    sampleRateHertz: 8000
                }
            }));
        });

        ws.on('message', m => {
            const data = m.toString();
            console.log('MESSAGE:', data.substring(0, 100));
        });

        ws.on('error', e => {
            console.error('ERROR:', e.message);
        });

        ws.on('unexpected-response', (req, res) => {
            console.error('UNEXPECTED HTTP STATUS:', res.statusCode);
            res.on('data', chunk => console.error(chunk.toString()));
            res.on('end', resolve);
        });

        ws.on('close', (c, r) => {
            console.log('CLOSED', c, r.toString());
            resolve();
        });
    });
}

(async () => {
    for (const u of urlsToTest) {
        await testWebSocket(u);
    }
})();
