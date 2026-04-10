import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MantleMcpError, toErrorPayload } from "./errors.js";
import { getPromptMessages, prompts } from "./prompts.js";
import { listResources, prefetchResources, readResource } from "./resources.js";
import { allTools } from "./tools/index.js";
export function createServer() {
    const server = new Server({ name: "mantle-mcp", version: "0.1.0" }, {
        capabilities: {
            tools: {},
            resources: {},
            prompts: {}
        }
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: Object.values(allTools).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema
        }))
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const args = (request.params.arguments ?? {});
        const tool = allTools[name];
        if (!tool) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            error: true,
                            code: "UNKNOWN_TOOL",
                            message: `Unknown tool: ${name}`,
                            suggestion: "Call ListTools first to discover available tool names.",
                            details: null
                        })
                    }
                ],
                isError: true
            };
        }
        try {
            const result = await tool.handler(args);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: JSON.stringify(toErrorPayload(error)) }],
                isError: true
            };
        }
    });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: listResources()
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const uri = request.params.uri;
        const resource = readResource(uri);
        if (!resource) {
            return {
                contents: [{ uri, mimeType: "text/plain", text: `Resource not found: ${uri}` }]
            };
        }
        return {
            contents: [{ uri, mimeType: resource.mimeType, text: resource.content }]
        };
    });
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
        prompts: prompts
    }));
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        const messages = getPromptMessages(request.params.name);
        if (!messages) {
            throw new MantleMcpError("PROMPT_NOT_FOUND", `Prompt not found: ${request.params.name}`, "Call ListPrompts to discover available prompt names.", { name: request.params.name });
        }
        return { messages };
    });
    return server;
}
export async function runServer() {
    const transportMode = process.env.MANTLE_MCP_TRANSPORT ?? "stdio";
    if (transportMode !== "stdio") {
        throw new Error("Only stdio transport is currently supported. Set MANTLE_MCP_TRANSPORT=stdio.");
    }
    const server = createServer();
    await prefetchResources();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    const shutdown = async () => {
        await server.close();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
