import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("cli layout", () => {
    it("publishes the CLI from the top-level cli directory", () => {
        const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
        expect(packageJson.bin?.["mantle-cli"]).toBe("dist/cli/index.js");
        expect(packageJson.files).toContain("src/README.md");
        expect(packageJson.files).toContain("cli/README.md");
        expect(existsSync("cli/index.ts")).toBe(true);
        expect(existsSync("cli/utils.ts")).toBe(true);
    });
});
