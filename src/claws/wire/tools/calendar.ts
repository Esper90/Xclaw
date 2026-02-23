import { SchemaType } from "@google/generative-ai";
import { registry, type McpTool } from "./registry";

const calendarTool: McpTool = {
    name: "create_calendar_event",
    description: "Create a calendar event for the user",
    geminiDeclaration: {
        name: "create_calendar_event",
        description: "Add an event to the user's calendar. DO NOT use this for simple reminders or alerts. Only use if the user explicitly requests to add something to their calendar.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                title: {
                    type: SchemaType.STRING,
                    description: "Event title",
                },
                start: {
                    type: SchemaType.STRING,
                    description: "ISO 8601 start datetime, e.g. 2026-03-01T10:00:00Z",
                },
                end: {
                    type: SchemaType.STRING,
                    description: "ISO 8601 end datetime",
                },
                description: {
                    type: SchemaType.STRING,
                    description: "Optional event description",
                },
            },
            required: ["title", "start", "end"],
        },
    },
    async execute(args): Promise<string> {
        const { title, start, end, description } = args as {
            title: string;
            start: string;
            end: string;
            description?: string;
        };

        // TODO: Integrate real calendar provider here.
        // Options: Google Calendar API, Notion Calendar, Caldav.
        // Example with Google Calendar API:
        //   const { google } = await import("googleapis");
        //   const auth = new google.auth.OAuth2(...);
        //   const calendar = google.calendar({ version: "v3", auth });
        //   await calendar.events.insert({ calendarId: "primary", requestBody: { ... } });

        console.log(`[calendar] STUB create_event → "${title}" ${start} → ${end}`);
        return `✅ Calendar event staged (stub): "${title}" on ${new Date(start).toLocaleString()}${description ? ` — ${description}` : ""}`;
    },
};

registry.register(calendarTool);
