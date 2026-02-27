import { InworldClient } from '@inworld/nodejs-sdk';
import * as dotenv from 'dotenv';
dotenv.config();

let rawKey = process.env.INWORLD_API_KEY || "";
rawKey = rawKey.replace(/[\r\n"']/g, '').trim();

async function testSDK() {
    try {
        console.log("Initializing InworldClient...");
        // the client constructor takes an apiKey and apiSecret usually, 
        // wait the API key from the panel is a single base64 string.
        // Let's decode it to see if it's `key:secret`
        const decoded = Buffer.from(rawKey, 'base64').toString('utf8');
        console.log("Decoded Base64:", decoded.substring(0, 10) + "... includes colon?", decoded.includes(':'));

        const [key, secret] = decoded.split(':');

        const client = new InworldClient().setApiKey({
            key: key,
            secret: secret
        });

        console.log("Client configured");
    } catch (e) {
        console.log("Error:", e);
    }
}
testSDK();
