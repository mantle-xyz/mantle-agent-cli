import { jsonSchema, tool } from "ai";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseMaybeJsonText(text) {
    const trimmed = text.trim();
    if (!trimmed) {
        return "";
    }
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return trimmed;
    }
}
function normalizeMcpResult(result) {
    if (!isRecord(result)) {
        return result;
    }
    if ("toolResult" in result) {
        return result.toolResult;
    }
    const content = Array.isArray(result.content) ? result.content : [];
    const normalizedContent = content.map((part) => {
        if (!isRecord(part)) {
            return part;
        }
        if (part.type === "text" && typeof part.text === "string") {
            return parseMaybeJsonText(part.text);
        }
        return part;
    });
    const compactedContent = normalizedContent.length === 1 ? normalizedContent[0] : normalizedContent;
    return {
        is_error: result.isError === true,
        content: compactedContent,
        structured_content: isRecord(result.structuredContent) ? result.structuredContent : null
    };
}
function normalizeSchema(schema) {
    return {
        ...schema,
        type: "object",
        properties: schema.properties ?? {},
        required: Array.isArray(schema.required) ? schema.required : []
    };
}
export function convertToAiSdkTools(mcpTools, client) {
    return Object.fromEntries(mcpTools.map((mcpTool) => [
        mcpTool.name,
        tool({
            description: mcpTool.description ?? "",
            inputSchema: jsonSchema(normalizeSchema(mcpTool.inputSchema)),
            execute: async (args) => {
                const callResult = await client.callTool({
                    name: mcpTool.name,
                    arguments: isRecord(args) ? args : {}
                });
                return normalizeMcpResult(callResult);
            }
        })
    ]));
}
