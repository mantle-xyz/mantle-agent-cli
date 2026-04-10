import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
function parsePositiveInteger(value, fallback) {
    if (!value) {
        return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
}
function parseNonNegativeInteger(value, fallback) {
    if (!value) {
        return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return fallback;
    }
    return parsed;
}
export function hasRequiredLlmConfig(env = process.env) {
    return Boolean(env.E2E_LLM_PROVIDER && env.E2E_LLM_API_KEY);
}
export function resolveE2EConfig(env = process.env) {
    const providerInput = env.E2E_LLM_PROVIDER;
    const apiKey = env.E2E_LLM_API_KEY;
    if (!providerInput || !apiKey) {
        throw new Error("E2E_LLM_PROVIDER and E2E_LLM_API_KEY are required.");
    }
    const provider = providerInput.toLowerCase();
    if (provider !== "openai" && provider !== "anthropic" && provider !== "openrouter") {
        throw new Error(`Unsupported E2E_LLM_PROVIDER: ${providerInput}`);
    }
    let defaultModel = "gpt-4o";
    if (provider === "anthropic") {
        defaultModel = "claude-sonnet-4-20250514";
    }
    else if (provider === "openrouter") {
        defaultModel = "openai/gpt-4o-mini";
    }
    const modelName = env.E2E_LLM_MODEL ?? defaultModel;
    return {
        provider,
        apiKey,
        modelName,
        timeoutMs: parsePositiveInteger(env.E2E_TIMEOUT_MS, 30000),
        maxRetries: parseNonNegativeInteger(env.E2E_MAX_RETRIES, 2),
        openRouterSiteUrl: env.E2E_OPENROUTER_SITE_URL,
        openRouterAppName: env.E2E_OPENROUTER_APP_NAME
    };
}
export function resolveE2EModel(config) {
    if (config.provider === "openai") {
        return createOpenAI({ apiKey: config.apiKey })(config.modelName);
    }
    if (config.provider === "openrouter") {
        const headers = {};
        if (config.openRouterSiteUrl) {
            headers["HTTP-Referer"] = config.openRouterSiteUrl;
        }
        if (config.openRouterAppName) {
            headers["X-Title"] = config.openRouterAppName;
        }
        return createOpenAI({
            name: "openrouter",
            baseURL: "https://openrouter.ai/api/v1",
            apiKey: config.apiKey,
            headers
        })(config.modelName);
    }
    return createAnthropic({ apiKey: config.apiKey })(config.modelName);
}
