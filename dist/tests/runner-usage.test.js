import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
    generateText: generateTextMock,
    stepCountIs: vi.fn(() => "stop")
}));
import { E2EAgentRunner } from "../e2e/lib/runner.js";
function buildScenario(overrides = {}) {
    return {
        id: "usage-scenario",
        module: "usage.module",
        toolName: "mantle_getBalance",
        prompt: "run tool",
        expectedToolCall: "mantle_getBalance",
        expectedOutcome: "success",
        outputAssertions: {},
        ...overrides
    };
}
function generateResult(options) {
    const { inputTokens, outputTokens, text, toolCalls, toolResults } = options;
    return {
        text,
        usage: {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens
        },
        steps: [
            {
                toolCalls: toolCalls ?? [{ toolName: "mantle_getBalance", input: { address: "0xabc" } }],
                toolResults: toolResults ?? []
            }
        ]
    };
}
describe("E2EAgentRunner usage accounting", () => {
    beforeEach(() => {
        generateTextMock.mockReset();
    });
    it("initializes when process cwd is not repo root", () => {
        const originalCwd = process.cwd();
        const temporaryCwd = mkdtempSync(path.join(tmpdir(), "runner-cwd-"));
        try {
            process.chdir(temporaryCwd);
            expect(() => new E2EAgentRunner({
                E2E_LLM_PROVIDER: "openai",
                E2E_LLM_API_KEY: "test-key",
                E2E_MAX_RETRIES: "0"
            })).not.toThrow();
        }
        finally {
            process.chdir(originalCwd);
            rmSync(temporaryCwd, { recursive: true, force: true });
        }
    });
    it("accumulates usage from each failed retry attempt", async () => {
        generateTextMock
            .mockResolvedValueOnce(generateResult({
            inputTokens: 11,
            outputTokens: 7,
            text: "attempt one"
        }))
            .mockResolvedValueOnce(generateResult({
            inputTokens: 13,
            outputTokens: 9,
            text: "attempt two"
        }));
        const runner = new E2EAgentRunner({
            E2E_LLM_PROVIDER: "openai",
            E2E_LLM_API_KEY: "test-key",
            E2E_MAX_RETRIES: "1"
        });
        const result = await runner.runScenario(buildScenario({ outputAssertions: { containsText: ["must appear"] } }));
        expect(result.status).toBe("failed");
        expect(result.attempts).toBe(2);
        expect(result.failureType).toBe("ASSERTION_FAILED");
        expect(result.usage).toEqual({
            inputTokens: 24,
            outputTokens: 16,
            totalTokens: 40
        });
    });
    it("retains usage on immediate non-retryable failures", async () => {
        generateTextMock.mockResolvedValueOnce(generateResult({
            inputTokens: 5,
            outputTokens: 3,
            text: "no tool call",
            toolCalls: []
        }));
        const runner = new E2EAgentRunner({
            E2E_LLM_PROVIDER: "openai",
            E2E_LLM_API_KEY: "test-key",
            E2E_MAX_RETRIES: "3"
        });
        const result = await runner.runScenario(buildScenario());
        expect(result.status).toBe("failed");
        expect(result.attempts).toBe(1);
        expect(result.failureType).toBe("TOOL_NOT_CALLED");
        expect(result.usage).toEqual({
            inputTokens: 5,
            outputTokens: 3,
            totalTokens: 8
        });
    });
    it("fails when expectedOutcome is tool-error but tool result is not an error", async () => {
        generateTextMock.mockResolvedValueOnce(generateResult({
            inputTokens: 4,
            outputTokens: 2,
            text: "tool returned success",
            toolResults: [
                {
                    toolName: "mantle_getBalance",
                    output: { is_error: false, content: { balance: "1" } }
                }
            ]
        }));
        const runner = new E2EAgentRunner({
            E2E_LLM_PROVIDER: "openai",
            E2E_LLM_API_KEY: "test-key",
            E2E_MAX_RETRIES: "0"
        });
        const result = await runner.runScenario(buildScenario({ expectedOutcome: "tool-error" }));
        expect(result.status).toBe("failed");
        expect(result.failureType).toBe("ASSERTION_FAILED");
    });
    it("fails when expectedOutcome is success but tool result is an error", async () => {
        generateTextMock.mockResolvedValueOnce(generateResult({
            inputTokens: 4,
            outputTokens: 2,
            text: "tool returned error",
            toolResults: [
                {
                    toolName: "mantle_getBalance",
                    output: { isError: true, content: { code: "boom" } }
                }
            ]
        }));
        const runner = new E2EAgentRunner({
            E2E_LLM_PROVIDER: "openai",
            E2E_LLM_API_KEY: "test-key",
            E2E_MAX_RETRIES: "0"
        });
        const result = await runner.runScenario(buildScenario({ expectedOutcome: "success" }));
        expect(result.status).toBe("failed");
        expect(result.failureType).toBe("ASSERTION_FAILED");
    });
    it("passes expectedOutcome checks when tool error state matches", async () => {
        generateTextMock.mockResolvedValueOnce(generateResult({
            inputTokens: 6,
            outputTokens: 2,
            text: "tool returned expected error",
            toolResults: [
                {
                    toolName: "mantle_getBalance",
                    output: { is_error: true, content: { code: "EXPECTED_ERROR" } }
                }
            ]
        }));
        const runner = new E2EAgentRunner({
            E2E_LLM_PROVIDER: "openai",
            E2E_LLM_API_KEY: "test-key",
            E2E_MAX_RETRIES: "0"
        });
        const result = await runner.runScenario(buildScenario({ expectedOutcome: "tool-error" }));
        expect(result.status).toBe("passed");
    });
    it("keeps stopWhen guard for non-openrouter providers", async () => {
        generateTextMock.mockResolvedValueOnce(generateResult({
            inputTokens: 3,
            outputTokens: 1,
            text: "ok"
        }));
        const runner = new E2EAgentRunner({
            E2E_LLM_PROVIDER: "openai",
            E2E_LLM_API_KEY: "test-key",
            E2E_MAX_RETRIES: "0"
        });
        const result = await runner.runScenario(buildScenario());
        expect(result.status).toBe("passed");
        expect(generateTextMock).toHaveBeenCalledTimes(1);
        expect(generateTextMock.mock.calls[0]?.[0]).toMatchObject({
            stopWhen: "stop"
        });
    });
    it("omits stopWhen for openrouter provider compatibility", async () => {
        generateTextMock.mockResolvedValueOnce(generateResult({
            inputTokens: 3,
            outputTokens: 1,
            text: "ok"
        }));
        const runner = new E2EAgentRunner({
            E2E_LLM_PROVIDER: "openrouter",
            E2E_LLM_API_KEY: "test-key",
            E2E_MAX_RETRIES: "0"
        });
        const result = await runner.runScenario(buildScenario());
        expect(result.status).toBe("passed");
        expect(generateTextMock).toHaveBeenCalledTimes(1);
        expect(generateTextMock.mock.calls[0]?.[0]).not.toHaveProperty("stopWhen");
    });
    it("passes text assertions when required fragments are present in tool output", async () => {
        generateTextMock.mockResolvedValueOnce(generateResult({
            inputTokens: 2,
            outputTokens: 1,
            text: "summary without key terms",
            toolResults: [
                {
                    toolName: "mantle_getBalance",
                    output: { is_error: false, content: { balance_mnt: "1.5" } }
                }
            ]
        }));
        const runner = new E2EAgentRunner({
            E2E_LLM_PROVIDER: "openai",
            E2E_LLM_API_KEY: "test-key",
            E2E_MAX_RETRIES: "0"
        });
        const result = await runner.runScenario(buildScenario({
            outputAssertions: {
                containsAnyText: ["balance_mnt"]
            }
        }));
        expect(result.status).toBe("passed");
    });
    it("limits available tools to the scenario expected tool", async () => {
        generateTextMock.mockResolvedValueOnce(generateResult({
            inputTokens: 2,
            outputTokens: 1,
            text: "ok"
        }));
        const runner = new E2EAgentRunner({
            E2E_LLM_PROVIDER: "openai",
            E2E_LLM_API_KEY: "test-key",
            E2E_MAX_RETRIES: "0"
        });
        runner.tools = {
            mantle_getBalance: { name: "mantle_getBalance" },
            mantle_getChainStatus: { name: "mantle_getChainStatus" }
        };
        const result = await runner.runScenario(buildScenario());
        expect(result.status).toBe("passed");
        const toolsArg = generateTextMock.mock.calls[0]?.[0]?.tools ?? {};
        expect(Object.keys(toolsArg)).toEqual(["mantle_getBalance"]);
    });
    it("retries when a wrong tool is called before the expected tool", async () => {
        generateTextMock
            .mockResolvedValueOnce(generateResult({
            inputTokens: 2,
            outputTokens: 1,
            text: "wrong tool first",
            toolCalls: [{ toolName: "mantle_getChainStatus", input: {} }]
        }))
            .mockResolvedValueOnce(generateResult({
            inputTokens: 3,
            outputTokens: 2,
            text: "expected tool second",
            toolCalls: [{ toolName: "mantle_getBalance", input: { address: "0xabc" } }]
        }));
        const runner = new E2EAgentRunner({
            E2E_LLM_PROVIDER: "openai",
            E2E_LLM_API_KEY: "test-key",
            E2E_MAX_RETRIES: "1"
        });
        const result = await runner.runScenario(buildScenario());
        expect(result.status).toBe("passed");
        expect(result.attempts).toBe(2);
    });
    it("injects a tool-call directive into the prompt", async () => {
        generateTextMock.mockResolvedValueOnce(generateResult({
            inputTokens: 2,
            outputTokens: 1,
            text: "ok"
        }));
        const runner = new E2EAgentRunner({
            E2E_LLM_PROVIDER: "openai",
            E2E_LLM_API_KEY: "test-key",
            E2E_MAX_RETRIES: "0"
        });
        const result = await runner.runScenario(buildScenario());
        expect(result.status).toBe("passed");
        const promptArg = String(generateTextMock.mock.calls[0]?.[0]?.prompt ?? "");
        expect(promptArg).toContain("You must call mantle_getBalance exactly once");
        expect(promptArg).toContain("run tool");
    });
    it("retries transient LLM errors before failing the scenario", async () => {
        generateTextMock
            .mockRejectedValueOnce(new Error("Internal Server Error"))
            .mockResolvedValueOnce(generateResult({
            inputTokens: 2,
            outputTokens: 1,
            text: "ok"
        }));
        const runner = new E2EAgentRunner({
            E2E_LLM_PROVIDER: "openai",
            E2E_LLM_API_KEY: "test-key",
            E2E_MAX_RETRIES: "1"
        });
        const result = await runner.runScenario(buildScenario());
        expect(result.status).toBe("passed");
        expect(result.attempts).toBe(2);
    });
    it("skips scenarios when skipUnless points to a placeholder endpoint", async () => {
        const runner = new E2EAgentRunner({
            E2E_LLM_PROVIDER: "openai",
            E2E_LLM_API_KEY: "test-key",
            E2E_MAX_RETRIES: "0",
            E2E_SUBGRAPH_ENDPOINT: "https://your-subgraph-endpoint"
        });
        const result = await runner.runScenario(buildScenario({ skipUnless: "E2E_SUBGRAPH_ENDPOINT" }));
        expect(result.status).toBe("skipped");
        expect(result.attempts).toBe(0);
        expect(result.skipReason).toContain("placeholder");
        expect(generateTextMock).not.toHaveBeenCalled();
    });
    it("runs scenarios when skipUnless value is configured", async () => {
        generateTextMock.mockResolvedValueOnce(generateResult({
            inputTokens: 2,
            outputTokens: 1,
            text: "ok"
        }));
        const runner = new E2EAgentRunner({
            E2E_LLM_PROVIDER: "openai",
            E2E_LLM_API_KEY: "test-key",
            E2E_MAX_RETRIES: "0",
            E2E_SUBGRAPH_ENDPOINT: "https://indexer.example.org/graphql"
        });
        const result = await runner.runScenario(buildScenario({ skipUnless: "E2E_SUBGRAPH_ENDPOINT" }));
        expect(result.status).toBe("passed");
        expect(generateTextMock).toHaveBeenCalledTimes(1);
    });
});
