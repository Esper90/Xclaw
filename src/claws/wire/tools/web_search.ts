import { SchemaType } from "@google/generative-ai";
import { config } from "../../config";
import { registry, McpTool } from "./registry";

/**
 * Perform a web search using the Tavily API.
 */
export async function performTavilySearch(query: string, maxResults: number = 5): Promise<string> {
    if (!config.TAVILY_API_KEY) {
        throw new Error("TAVILY_API_KEY is missing from configuration.");
    }

    const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            api_key: config.TAVILY_API_KEY,
            query: query,
            search_depth: "basic",
            include_answer: false,
            include_images: false,
            include_raw_content: false,
            max_results: maxResults,
        }),
    });

    if (!res.ok) {
        throw new Error(`Tavily API responded with status: ${res.status}`);
    }

    const data = await res.json();
    if (!data.results || data.results.length === 0) {
        return "No relevant search results found.";
    }

    let report = `Web search results for "${query}":\n\n`;
    for (const item of data.results) {
        report += `[${item.title}](${item.url})\n${item.content}\n\n`;
    }

    return report.trim();
}

/**
 * Web Search Tool for Gemini
 */
const webSearchTool: McpTool = {
    name: "web_search",
    description: "Search the web for up-to-date information, news, or viral trends. Crucial for pulling live examples when writing viral tweets.",
    execute: async (args: { query: string }) => {
        if (!args.query) return "Error: No search query provided.";
        try {
            return await performTavilySearch(args.query, 6);
        } catch (err: any) {
            return `❌ Web search failed: ${err.message}`;
        }
    },
    geminiDeclaration: {
        name: "web_search",
        description: "Search the web for real-time information and viral trends.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                query: {
                    type: SchemaType.STRING,
                    description: "The search query. Be specific, e.g., 'recent trending news about AI agents'",
                }
            },
            required: ["query"],
        },
    },
};

// Auto-register during import
registry.register(webSearchTool);
