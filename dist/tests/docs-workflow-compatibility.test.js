import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("docs workflow compatibility", () => {
    it("does not pin platform-specific Next.js SWC binaries", () => {
        const docsPackageJson = JSON.parse(readFileSync("docs/package.json", "utf8"));
        const dependencyNames = [
            ...Object.keys(docsPackageJson.dependencies ?? {}),
            ...Object.keys(docsPackageJson.devDependencies ?? {})
        ];
        const pinnedSwcPackages = dependencyNames.filter((name) => name.startsWith("@next/swc-"));
        expect(pinnedSwcPackages).toEqual([]);
    });
});
