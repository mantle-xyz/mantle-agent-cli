import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("docs pages configuration", () => {
    it("uses mantle-xyz repository URLs throughout the docs site metadata", () => {
        const layout = readFileSync("docs/app/layout.tsx", "utf8");
        const themeConfig = readFileSync("docs/theme.config.tsx", "utf8");
        expect(layout).toContain("https://mantle-xyz.github.io/mantle-agent-scaffold");
        expect(themeConfig).toContain("https://github.com/mantle-xyz/mantle-agent-scaffold");
        expect(themeConfig).toContain("https://github.com/mantle-xyz/mantle-agent-scaffold/tree/main/docs");
    });
    it("supports GitHub Pages enablement for the org repository", () => {
        const workflow = readFileSync(".github/workflows/docs-pages.yml", "utf8");
        expect(workflow).toContain("PAGES_ENABLEMENT_TOKEN");
        expect(workflow).toContain("enablement: true");
        expect(workflow).toContain("HAS_PAGES_ENABLEMENT_TOKEN");
        expect(workflow).not.toContain("if: ${{ secrets.PAGES_ENABLEMENT_TOKEN");
    });
});
