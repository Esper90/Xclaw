import { SchemaType } from "@google/generative-ai";
import { registry, type McpTool } from "./registry";

const emailTool: McpTool = {
    name: "send_email",
    description: "Send an email on behalf of the user",
    geminiDeclaration: {
        name: "send_email",
        description: "Send an email to a recipient with a subject and body",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                to: {
                    type: SchemaType.STRING,
                    description: "Recipient email address",
                },
                subject: {
                    type: SchemaType.STRING,
                    description: "Email subject line",
                },
                body: {
                    type: SchemaType.STRING,
                    description: "Email body text",
                },
            },
            required: ["to", "subject", "body"],
        },
    },
    async execute(args): Promise<string> {
        const { to, subject, body } = args as { to: string; subject: string; body: string };

        // TODO: Integrate real email provider here.
        // Options: Resend (https://resend.com), Nodemailer+SMTP, Gmail API.
        // Example with Resend:
        //   const { Resend } = await import("resend");
        //   const resend = new Resend(process.env.RESEND_API_KEY);
        //   await resend.emails.send({ from: "...", to, subject, html: body });

        console.log(`[email] STUB send_email → to=${to} subject="${subject}"`);
        return `✅ Email draft ready (stub): To: ${to} | Subject: ${subject}`;
    },
};

registry.register(emailTool);
