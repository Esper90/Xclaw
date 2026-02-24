import { SchemaType } from "@google/generative-ai";
import { fetchXProfile } from "../xService";
import { registry, McpTool } from "./registry";

/**
 * Fetch X Profile Tool
 */
const fetchXProfileTool: McpTool = {
    name: "fetch_x_profile",
    description: "Look up an X (Twitter) user by handle to get their bio, follower count, and recent tweets. Default to Lite mode (useCache=true, tweetCount=5) to save user costs.",
    execute: async (args: { handle: string, useCache?: boolean, tweetCount?: number, userId: string }) => {
        if (!args.handle || !args.userId) {
            return "Error: handle and userId are required.";
        }

        // Apply Cost-Protecting Defaults
        const useCache = args.useCache !== undefined ? args.useCache : true;
        const requestedCount = args.tweetCount && args.tweetCount > 0 ? args.tweetCount : 5;
        // Hard limit to 30 tweets to physically prevent $0.50 runaway calls
        const finalCount = Math.min(requestedCount, 30);

        try {
            const result = await fetchXProfile(args.handle, finalCount, useCache, args.userId);

            let responseString = `=== Profile: @${args.handle.replace("@", "")} ===\n`;
            responseString += `Name: ${result.profile.name}\n`;
            responseString += `Bio: ${result.profile.description}\n`;
            responseString += `Followers: ${result.profile.public_metrics?.followers_count} | Following: ${result.profile.public_metrics?.following_count}\n`;
            responseString += `Verified: ${result.profile.verified}\n\n`;

            responseString += `=== Recent Tweets (${result.tweets.length} fetched) ===\n`;
            for (const t of result.tweets) {
                responseString += `[${t.created_at}] [Likes: ${t.public_metrics?.like_count} | RTs: ${t.public_metrics?.retweet_count}]\n${t.text}\n---\n`;
            }

            if (result.source === "cache") {
                responseString = `[SYSTEM NOTE: This data was retrieved for free from the local 24-hour cache. If the user explicitly asks for 'fresh' or 'live' data, warn them it costs ~$0.16 and ask for confirmation before calling this tool again with useCache=false.]\n\n` + responseString;
            }

            return responseString;
        } catch (err: any) {
            return `❌ Failed to fetch profile: ${err.message}`;
        }
    },
    geminiDeclaration: {
        name: "fetch_x_profile",
        description: "Look up an X (Twitter) user by handle to read their bio and timeline. DEFAULT to 'useCache=true' and 'tweetCount=5' unless the user explicitly requests a deep dive.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                handle: { type: SchemaType.STRING, description: "The X handle to look up (e.g. '@elonmusk' or 'elonmusk')." },
                useCache: { type: SchemaType.BOOLEAN, description: "Set to false ONLY if the user explicitly demands 'fresh' data and has approved the ~$0.16 cost. Otherwise, leave true or undefined." },
                tweetCount: { type: SchemaType.INTEGER, description: "How many tweets to fetch. Default is 5. Max allowed is 30. Only increase if user asks for a 'deep dive'. Every 5 tweets adds ~$0.025 to their cost." },
                userId: { type: SchemaType.STRING, description: "The Telegram user ID of the current user." }
            },
            required: ["handle", "userId"]
        }
    }
};

// Auto-register
registry.register(fetchXProfileTool);
