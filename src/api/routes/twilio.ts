import { Router } from "express";

export const twilioRouter = Router();

/**
 * POST /twilio/incoming
 * Called by Twilio when someone calls the phone number.
 * We return TwiML to immediately connect the call to our WebSocket Media Stream.
 */
twilioRouter.post("/incoming", (req, res) => {
    // Railway provides the HOST in a few ways. Usually req.hostname is sufficient if behind a standard proxy.
    // For local dev with ngrok, req.hostname works too.
    const host = req.get("host") || "localhost:8080";
    const protocol = req.protocol === "https" || host.includes("up.railway.app") || host.includes("ngrok") ? "wss" : "ws";

    const streamUrl = `${protocol}://${host}/twilio/stream`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Connecting you to X claw...</Say>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

    res.type("text/xml");
    res.send(twiml);
});
