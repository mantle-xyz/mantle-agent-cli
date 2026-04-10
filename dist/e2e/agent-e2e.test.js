import { describe, expect, it } from "vitest";
import { E2EAgentRunner, createScenarioReporter, evaluateReleaseGate, hasRequiredLlmConfig } from "./lib/runner.js";
import { allScenarios } from "./scenarios/index.js";
describe("mantle-mcp agent e2e", () => {
    const requireLive = process.env.E2E_REQUIRE_LIVE === "true";
    it("registers all v0.2 scenarios", () => {
        const reporter = createScenarioReporter();
        expect(allScenarios).toHaveLength(19);
        expect(reporter.summary().total).toBe(0);
    });
    it("requires LLM config when live E2E is enforced", () => {
        if (!requireLive) {
            return;
        }
        expect(hasRequiredLlmConfig()).toBe(true);
    });
    const runE2E = hasRequiredLlmConfig() ? it : it.skip;
    runE2E("runs all scenarios against a live LLM", async () => {
        const startedAt = new Date();
        const runner = new E2EAgentRunner();
        const reporter = createScenarioReporter();
        try {
            await runner.setup();
            for (const scenario of allScenarios) {
                const result = await runner.runScenario(scenario);
                reporter.record(result);
            }
        }
        finally {
            await runner.teardown();
        }
        reporter.print({
            provider: runner.info().provider,
            modelName: runner.info().modelName,
            startedAt
        });
        const releaseGate = evaluateReleaseGate(reporter.results());
        if (!releaseGate.passed) {
            const details = releaseGate.failures
                .map((item) => `${item.scenarioId}: ${item.failureType ?? "LLM_ERROR"}${item.message ? ` (${item.message})` : ""}`)
                .join("\n");
            const hardFailureDetails = releaseGate.hardFailures
                .map((item) => `${item.scenarioId}: ${item.failureType}`)
                .join("\n");
            throw new Error([
                `E2E release gate failed: ${(releaseGate.passRate * 100).toFixed(1)}% pass rate (${releaseGate.passedScenarios}/${releaseGate.executed} executed; required >= ${(releaseGate.minPassRate * 100).toFixed(0)}%).`,
                `Hard failures: ${releaseGate.hardFailures.length}.`,
                hardFailureDetails ? `Hard failure details:\n${hardFailureDetails}` : "",
                details ? `Failure details:\n${details}` : ""
            ]
                .filter(Boolean)
                .join("\n"));
        }
        expect(reporter.summary().total).toBe(allScenarios.length);
    });
});
