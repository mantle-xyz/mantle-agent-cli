import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("version consistency", () => {
    it("aligns package, docs, server, and cli on v0.1.0", () => {
        const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
        const docsPackageJson = JSON.parse(readFileSync("docs/package.json", "utf8"));
        const server = readFileSync("src/server.ts", "utf8");
        const cli = readFileSync("cli/index.ts", "utf8");
        const docsIndex = readFileSync("docs/content/index.mdx", "utf8");
        expect(packageJson.version).toBe("0.1.0");
        expect(docsPackageJson.version).toBe("0.1.0");
        expect(server).toContain('version: "0.1.0"');
        expect(cli).toContain('.version("0.1.0")');
        expect(docsIndex).toContain("v0.1.0");
    });
});
