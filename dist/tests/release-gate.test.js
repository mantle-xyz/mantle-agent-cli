import { describe, expect, it } from "vitest";
import { evaluateReleaseGate } from "../e2e/lib/runner.js";
function passedRecord(id) {
    return {
        scenarioId: id,
        status: "passed",
        attempts: 1,
        durationMs: 100,
        usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15
        }
    };
}
function failedRecord(id, failureType) {
    return {
        scenarioId: id,
        status: "failed",
        attempts: 1,
        durationMs: 100,
        usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15
        },
        failureType,
        message: `${failureType} happened`
    };
}
function skippedRecord(id) {
    return {
        scenarioId: id,
        status: "skipped",
        attempts: 0,
        durationMs: 0,
        usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0
        },
        skipReason: "indexer not configured"
    };
}
describe("evaluateReleaseGate", () => {
    it("passes when pass rate is >=90% and there are no hard failures", () => {
        const records = [
            ...Array.from({ length: 9 }, (_, index) => passedRecord(`pass-${index + 1}`)),
            failedRecord("soft-failure", "ASSERTION_FAILED"),
            skippedRecord("skip-1"),
            skippedRecord("skip-2")
        ];
        const result = evaluateReleaseGate(records);
        expect(result.passed).toBe(true);
        expect(result.executed).toBe(10);
        expect(result.passRate).toBe(0.9);
        expect(result.hardFailures).toHaveLength(0);
    });
    it("fails when pass rate is below 90%", () => {
        const records = [
            ...Array.from({ length: 8 }, (_, index) => passedRecord(`pass-${index + 1}`)),
            failedRecord("soft-failure-1", "ASSERTION_FAILED"),
            failedRecord("soft-failure-2", "WRONG_ARGS"),
            skippedRecord("skip-1"),
            skippedRecord("skip-2")
        ];
        const result = evaluateReleaseGate(records);
        expect(result.passed).toBe(false);
        expect(result.executed).toBe(10);
        expect(result.passRate).toBe(0.8);
    });
    it("fails when TOOL_NOT_CALLED exists even with pass rate >=90%", () => {
        const records = [
            ...Array.from({ length: 9 }, (_, index) => passedRecord(`pass-${index + 1}`)),
            failedRecord("hard-failure", "TOOL_NOT_CALLED"),
            skippedRecord("skip-1")
        ];
        const result = evaluateReleaseGate(records);
        expect(result.passed).toBe(false);
        expect(result.passRate).toBe(0.9);
        expect(result.hardFailures).toHaveLength(1);
        expect(result.hardFailures[0]?.failureType).toBe("TOOL_NOT_CALLED");
    });
    it("fails when TIMEOUT exists even with pass rate >=90%", () => {
        const records = [
            ...Array.from({ length: 9 }, (_, index) => passedRecord(`pass-${index + 1}`)),
            failedRecord("hard-failure", "TIMEOUT"),
            skippedRecord("skip-1")
        ];
        const result = evaluateReleaseGate(records);
        expect(result.passed).toBe(false);
        expect(result.passRate).toBe(0.9);
        expect(result.hardFailures).toHaveLength(1);
        expect(result.hardFailures[0]?.failureType).toBe("TIMEOUT");
    });
    it("fails when LLM_ERROR exists even with pass rate >=90%", () => {
        const records = [
            ...Array.from({ length: 9 }, (_, index) => passedRecord(`pass-${index + 1}`)),
            failedRecord("hard-failure", "LLM_ERROR"),
            skippedRecord("skip-1")
        ];
        const result = evaluateReleaseGate(records);
        expect(result.passed).toBe(false);
        expect(result.passRate).toBe(0.9);
        expect(result.hardFailures).toHaveLength(1);
        expect(result.hardFailures[0]?.failureType).toBe("LLM_ERROR");
    });
});
