import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("component readmes", () => {
    it("documents the MCP server in src/README.md", () => {
        expect(existsSync("src/README.md")).toBe(true);
        const readme = readFileSync("src/README.md", "utf8");
        expect(readme).toContain("# MCP Server");
        expect(readme).toContain("chain");
        expect(readme).toContain("registry");
        expect(readme).toContain("account");
        expect(readme).toContain("token");
        expect(readme).toContain("DeFi");
        expect(readme).toContain("indexer");
        expect(readme).toContain("diagnostics");
    });
    it("documents the CLI in cli/README.md", () => {
        expect(existsSync("cli/README.md")).toBe(true);
        const readme = readFileSync("cli/README.md", "utf8");
        expect(readme).toContain("# CLI");
        expect(readme).toContain("mantle-cli");
        expect(readme).toContain("chain info");
        expect(readme).toContain("registry resolve");
    });
});
