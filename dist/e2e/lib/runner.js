import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generateText, stepCountIs } from "ai";
import { createServer } from "../../src/server.js";
import { hasRequiredLlmConfig, resolveE2EConfig, resolveE2EModel } from "./model.js";
import { convertToAiSdkTools } from "./tool-adapter.js";
const TEMPLATE_PATTERN = /\{([A-Z0-9_]+)\}/g;
const SERVER_INSTRUCTIONS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../SERVER_INSTRUCTIONS.md");
const HARD_RELEASE_FAILURE_TYPES = new Set([
    "TOOL_NOT_CALLED",
    "TIMEOUT",
    "LLM_ERROR"
]);
function isHardReleaseFailure(failureType) {
    if (!failureType) {
        return false;
    }
    return HARD_RELEASE_FAILURE_TYPES.has(failureType);
}
export function evaluateReleaseGate(records, minPassRate = 0.9) {
    const passedScenarios = records.filter((item) => item.status === "passed").length;
    const failures = records.filter((item) => item.status === "failed");
    const hardFailures = failures.filter((item) => isHardReleaseFailure(item.failureType));
    const skippedScenarios = records.filter((item) => item.status === "skipped").length;
    const executed = passedScenarios + failures.length;
    const passRate = executed === 0 ? 1 : passedScenarios / executed;
    const meetsPassRate = passRate >= minPassRate;
    return {
        minPassRate,
        total: records.length,
        executed,
        passedScenarios,
        failedScenarios: failures.length,
        skippedScenarios,
        passRate,
        meetsPassRate,
        failures,
        hardFailures,
        passed: meetsPassRate && hardFailures.length === 0
    };
}
class ScenarioFailure extends Error {
    failureType;
    constructor(failureType, message) {
        super(message);
        this.failureType = failureType;
        this.name = "ScenarioFailure";
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function resolveTemplateString(input, env) {
    return input.replace(TEMPLATE_PATTERN, (_, key) => env[key] ?? `{${key}}`);
}
function resolveTemplateValue(value, env) {
    if (typeof value === "string") {
        return resolveTemplateString(value, env);
    }
    if (Array.isArray(value)) {
        return value.map((item) => resolveTemplateValue(item, env));
    }
    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplateValue(item, env)]));
    }
    return value;
}
function deepPartialMatch(actual, expected) {
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual) || actual.length < expected.length) {
            return false;
        }
        return expected.every((item, index) => deepPartialMatch(actual[index], item));
    }
    if (isRecord(expected)) {
        if (!isRecord(actual)) {
            return false;
        }
        return Object.entries(expected).every(([key, value]) => deepPartialMatch(actual[key], value));
    }
    return actual === expected;
}
function normalizeContainsText(values) {
    return (values ?? []).map((value) => value.toLowerCase());
}
function extractErrorFlag(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    if (value.is_error === true || value.isError === true) {
        return true;
    }
    if (value.is_error === false || value.isError === false) {
        return false;
    }
    return undefined;
}
function resolveToolResultErrorFlag(toolResult) {
    return extractErrorFlag(toolResult) ?? extractErrorFlag(toolResult.output);
}
function toSearchableText(value) {
    if (typeof value === "string") {
        return value;
    }
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
function extractToolCalls(result) {
    return result.steps.flatMap((step) => {
        const toolResults = step.toolResults ?? [];
        const consumedResultIndexes = new Set();
        return step.toolCalls.map((call) => {
            let matchedResultIndex = -1;
            if (typeof call.toolCallId === "string") {
                matchedResultIndex = toolResults.findIndex((toolResult, index) => !consumedResultIndexes.has(index) && toolResult.toolCallId === call.toolCallId);
            }
            if (matchedResultIndex === -1) {
                matchedResultIndex = toolResults.findIndex((toolResult, index) => !consumedResultIndexes.has(index) && toolResult.toolName === call.toolName);
            }
            let resultIsError;
            let resultText;
            if (matchedResultIndex !== -1) {
                consumedResultIndexes.add(matchedResultIndex);
                const matchedResult = toolResults[matchedResultIndex];
                resultIsError = resolveToolResultErrorFlag(matchedResult);
                resultText = toSearchableText(matchedResult.output ?? matchedResult);
            }
            return {
                name: call.toolName,
                args: isRecord(call.input) ? call.input : {},
                resultIsError,
                resultText
            };
        });
    });
}
function usageFromResult(result) {
    const inputTokens = result.usage.inputTokens ?? 0;
    const outputTokens = result.usage.outputTokens ?? 0;
    const totalTokens = result.usage.totalTokens ?? inputTokens + outputTokens;
    return {
        inputTokens,
        outputTokens,
        totalTokens
    };
}
function emptyUsage() {
    return {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
    };
}
function addUsage(current, next) {
    return {
        inputTokens: current.inputTokens + next.inputTokens,
        outputTokens: current.outputTokens + next.outputTokens,
        totalTokens: current.totalTokens + next.totalTokens
    };
}
function isRetryableFailure(type) {
    return type === "WRONG_ARGS" || type === "ASSERTION_FAILED" || type === "LLM_ERROR";
}
const PLACEHOLDER_ENV_VALUES = new Set([
    "https://your-subgraph-endpoint",
    "https://your-sql-endpoint",
    "your-api-key-here"
]);
function isConfiguredEnvValue(value) {
    if (!value) {
        return false;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return false;
    }
    const lower = trimmed.toLowerCase();
    if (PLACEHOLDER_ENV_VALUES.has(lower)) {
        return false;
    }
    if (lower.startsWith("https://your-") || lower.startsWith("http://your-")) {
        return false;
    }
    return true;
}
function classifyUnexpectedError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("abort")) {
        return new ScenarioFailure("TIMEOUT", message);
    }
    return new ScenarioFailure("LLM_ERROR", message);
}
function assertScenario(scenario, toolCalls, text, env) {
    const expectedToolCall = scenario.expectedToolCall;
    const matchedToolCall = toolCalls.find((call) => call.name === expectedToolCall);
    if (!matchedToolCall) {
        const calledNames = toolCalls.map((item) => item.name).join(", ") || "none";
        if (toolCalls.length > 0) {
            throw new ScenarioFailure("WRONG_ARGS", `Agent did not call ${expectedToolCall}. Called: ${calledNames}`);
        }
        throw new ScenarioFailure("TOOL_NOT_CALLED", `Agent did not call ${expectedToolCall}. Called: ${calledNames}`);
    }
    const requiredArgs = scenario.outputAssertions.requiredArgs ?? [];
    const missingKeys = requiredArgs.filter((key) => !(key in matchedToolCall.args));
    if (missingKeys.length > 0) {
        throw new ScenarioFailure("WRONG_ARGS", `Missing required args for ${expectedToolCall}: ${missingKeys.join(", ")}`);
    }
    const toolArgsMatch = scenario.outputAssertions.toolArgsMatch
        ? resolveTemplateValue(scenario.outputAssertions.toolArgsMatch, env)
        : undefined;
    if (toolArgsMatch && !deepPartialMatch(matchedToolCall.args, toolArgsMatch)) {
        throw new ScenarioFailure("WRONG_ARGS", `Tool args mismatch for ${expectedToolCall}. Expected partial ${JSON.stringify(toolArgsMatch)}, got ${JSON.stringify(matchedToolCall.args)}`);
    }
    const toolArgsMatchAny = scenario.outputAssertions.toolArgsMatchAny
        ? resolveTemplateValue(scenario.outputAssertions.toolArgsMatchAny, env)
        : undefined;
    if (toolArgsMatchAny &&
        toolArgsMatchAny.length > 0 &&
        !toolArgsMatchAny.some((pattern) => deepPartialMatch(matchedToolCall.args, pattern))) {
        throw new ScenarioFailure("WRONG_ARGS", `Tool args mismatch for ${expectedToolCall}. Expected one of ${JSON.stringify(toolArgsMatchAny)}, got ${JSON.stringify(matchedToolCall.args)}`);
    }
    const searchableText = `${text}\n${matchedToolCall.resultText ?? ""}`;
    const lowerText = searchableText.toLowerCase();
    const containsText = normalizeContainsText(scenario.outputAssertions.containsText);
    const missingText = containsText.filter((needle) => !lowerText.includes(needle));
    if (missingText.length > 0) {
        throw new ScenarioFailure("ASSERTION_FAILED", `Missing output text fragments: ${missingText.join(", ")}`);
    }
    const containsAnyText = normalizeContainsText(scenario.outputAssertions.containsAnyText);
    if (containsAnyText.length > 0 &&
        !containsAnyText.some((needle) => lowerText.includes(needle))) {
        throw new ScenarioFailure("ASSERTION_FAILED", `Output did not contain any of: ${containsAnyText.join(", ")}`);
    }
    const outcomeExpectedError = scenario.expectedOutcome === "tool-error";
    const outcomeActualError = matchedToolCall.resultIsError === true;
    if (outcomeExpectedError && !outcomeActualError) {
        throw new ScenarioFailure("ASSERTION_FAILED", `Expected ${expectedToolCall} to return an error result.`);
    }
    if (!outcomeExpectedError && outcomeActualError) {
        throw new ScenarioFailure("ASSERTION_FAILED", `Expected ${expectedToolCall} to return a success result.`);
    }
}
function formatSeconds(ms) {
    return `${(ms / 1000).toFixed(1)}s`;
}
class ScenarioReporter {
    records = [];
    record(result) {
        this.records.push(result);
    }
    results() {
        return [...this.records];
    }
    summary() {
        const total = this.records.length;
        const passed = this.records.filter((item) => item.status === "passed").length;
        const failed = this.records.filter((item) => item.status === "failed").length;
        const skipped = this.records.filter((item) => item.status === "skipped").length;
        const totalInputTokens = this.records.reduce((sum, item) => sum + item.usage.inputTokens, 0);
        const totalOutputTokens = this.records.reduce((sum, item) => sum + item.usage.outputTokens, 0);
        const totalTokens = this.records.reduce((sum, item) => sum + item.usage.totalTokens, 0);
        const durationMs = this.records.reduce((sum, item) => sum + item.durationMs, 0);
        return {
            total,
            passed,
            failed,
            skipped,
            totalInputTokens,
            totalOutputTokens,
            totalTokens,
            durationMs
        };
    }
    print(metadata) {
        const summary = this.summary();
        console.log("=== Mantle MCP E2E Agent Test Report ===");
        console.log(`Provider: ${metadata.provider} (${metadata.modelName})`);
        console.log(`Date: ${metadata.startedAt.toISOString()}`);
        console.log(`Duration: ${formatSeconds(summary.durationMs)}`);
        console.log("");
        console.log(`Results: ${summary.passed}/${summary.total} PASS, ${summary.failed} FAIL, ${summary.skipped} SKIP`);
        console.log("");
        for (const record of this.records) {
            if (record.status === "passed") {
                console.log(`PASS  ${record.scenarioId} (${formatSeconds(record.durationMs)}, ${record.attempts} attempt${record.attempts === 1 ? "" : "s"})`);
                continue;
            }
            if (record.status === "skipped") {
                console.log(`SKIP  ${record.scenarioId} (skipped: ${record.skipReason ?? "no reason"})`);
                continue;
            }
            console.log(`FAIL  ${record.scenarioId} (${formatSeconds(record.durationMs)}, ${record.attempts} attempt${record.attempts === 1 ? "" : "s"})`);
            console.log(`      -> ${record.failureType}: ${record.message}`);
        }
        console.log("");
        console.log(`Total LLM tokens: ${summary.totalTokens} (prompt: ${summary.totalInputTokens}, completion: ${summary.totalOutputTokens})`);
    }
}
export function createScenarioReporter() {
    const reporter = new ScenarioReporter();
    return {
        record: (result) => reporter.record(result),
        results: () => reporter.results(),
        summary: () => reporter.summary(),
        print: (metadata) => reporter.print(metadata)
    };
}
export class E2EAgentRunner {
    env;
    config;
    model;
    systemPrompt;
    server = null;
    client = null;
    tools = {};
    constructor(env = process.env) {
        this.env = env;
        this.config = resolveE2EConfig(env);
        this.model = resolveE2EModel(this.config);
        this.systemPrompt = readFileSync(SERVER_INSTRUCTIONS_PATH, "utf8");
    }
    info() {
        return {
            provider: this.config.provider,
            modelName: this.config.modelName,
            timeoutMs: this.config.timeoutMs,
            maxRetries: this.config.maxRetries
        };
    }
    async setup() {
        const server = createServer();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const client = new Client({ name: "e2e-agent", version: "1.0.0" });
        await client.connect(clientTransport);
        const { tools } = await client.listTools();
        this.server = server;
        this.client = client;
        this.tools = convertToAiSdkTools(tools, client);
    }
    async teardown() {
        await this.client?.close();
        await this.server?.close();
        this.client = null;
        this.server = null;
        this.tools = {};
    }
    async runScenario(scenario) {
        const scenarioStart = Date.now();
        if (scenario.skipUnless) {
            const skipEnvValue = this.env[scenario.skipUnless];
            if (!skipEnvValue) {
                return {
                    scenarioId: scenario.id,
                    status: "skipped",
                    attempts: 0,
                    durationMs: Date.now() - scenarioStart,
                    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                    skipReason: `${scenario.skipUnless} not set`
                };
            }
            if (!isConfiguredEnvValue(skipEnvValue)) {
                return {
                    scenarioId: scenario.id,
                    status: "skipped",
                    attempts: 0,
                    durationMs: Date.now() - scenarioStart,
                    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                    skipReason: `${scenario.skipUnless} is a placeholder value`
                };
            }
        }
        if (!this.model) {
            throw new Error("Model is not initialized.");
        }
        const resolvedScenario = {
            ...scenario,
            prompt: resolveTemplateString(scenario.prompt, this.env)
        };
        const executionPrompt = [
            `You must call ${resolvedScenario.expectedToolCall} exactly once before answering.`,
            "Do not answer from prior knowledge without calling the tool.",
            resolvedScenario.prompt
        ].join("\n\n");
        const expectedTool = this.tools[resolvedScenario.expectedToolCall];
        // Expose the FULL tool surface so the model must make the correct routing
        // decision. If the expected tool is missing, use all tools as fallback.
        const scenarioTools = expectedTool ? this.tools : this.tools;
        const maxAttempts = 1 + this.config.maxRetries;
        let lastFailure;
        let accumulatedUsage = emptyUsage();
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                const stopWhen = this.config.provider === "openrouter" ? undefined : stepCountIs(3);
                const result = await generateText({
                    model: this.model,
                    tools: scenarioTools,
                    prompt: executionPrompt,
                    system: this.systemPrompt,
                    maxRetries: 0,
                    timeout: resolvedScenario.timeoutMs ?? this.config.timeoutMs,
                    ...(stopWhen ? { stopWhen } : {})
                });
                const attemptUsage = usageFromResult(result);
                accumulatedUsage = addUsage(accumulatedUsage, attemptUsage);
                const toolCalls = extractToolCalls(result);
                assertScenario(resolvedScenario, toolCalls, result.text, this.env);
                return {
                    scenarioId: scenario.id,
                    status: "passed",
                    attempts: attempt,
                    durationMs: Date.now() - scenarioStart,
                    usage: attemptUsage
                };
            }
            catch (error) {
                const failure = error instanceof ScenarioFailure ? error : classifyUnexpectedError(error);
                lastFailure = failure;
                if (!isRetryableFailure(failure.failureType) || attempt >= maxAttempts) {
                    return {
                        scenarioId: scenario.id,
                        status: "failed",
                        attempts: attempt,
                        durationMs: Date.now() - scenarioStart,
                        usage: accumulatedUsage,
                        failureType: failure.failureType,
                        message: failure.message
                    };
                }
            }
        }
        return {
            scenarioId: scenario.id,
            status: "failed",
            attempts: maxAttempts,
            durationMs: Date.now() - scenarioStart,
            usage: accumulatedUsage,
            failureType: lastFailure?.failureType ?? "LLM_ERROR",
            message: lastFailure?.message ?? "Unknown failure"
        };
    }
}
export { hasRequiredLlmConfig };
