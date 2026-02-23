import type {
    FunctionDeclaration,
    FunctionDeclarationsTool,
} from "@google/generative-ai";

export interface McpTool {
    /** Unique tool name (matches Gemini function declaration name) */
    name: string;
    /** Human-readable description for debugging */
    description: string;
    /** Execute the tool with the given arguments, plus an optional execution context */
    execute(args: Record<string, unknown>, context?: Record<string, unknown>): Promise<string>;
    /** Gemini function declaration */
    geminiDeclaration: FunctionDeclaration;
}

class ToolRegistry {
    private tools = new Map<string, McpTool>();

    register(tool: McpTool): void {
        this.tools.set(tool.name, tool);
        console.log(`[tools] Registered tool: ${tool.name}`);
    }

    get(name: string): McpTool | undefined {
        return this.tools.get(name);
    }

    all(): McpTool[] {
        return Array.from(this.tools.values());
    }

    /** Returns Gemini FunctionDeclarationsTool[] format for passing to the model */
    toGeminiTools(): FunctionDeclarationsTool[] {
        const declarations = this.all()
            .map((t) => t.geminiDeclaration)
            .filter(Boolean);
        if (declarations.length === 0) return [];
        return [{ functionDeclarations: declarations }];
    }

    /** Dispatch a function call result from Gemini */
    async dispatch(name: string, args: Record<string, unknown>, context?: Record<string, unknown>): Promise<string> {
        const tool = this.tools.get(name);
        if (!tool) return `Error: tool "${name}" not found`;
        try {
            return await tool.execute(args, context);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Error executing tool "${name}": ${msg}`;
        }
    }
}

export const registry = new ToolRegistry();
