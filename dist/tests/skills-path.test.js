import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSkillsReference } from "../src/lib/skills-path.js";
describe("readSkillsReference", () => {
    it("tells the operator how to initialize the skills checkout when it is missing", () => {
        const tempDir = mkdtempSync(path.join(tmpdir(), "skills-missing-"));
        try {
            expect(() => readSkillsReference("skills/mantle-network-primer/references/mantle-network-basics.md", tempDir)).toThrow(/npm run skills:init/);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it("reads from the nested skills tree exposed by the canonical submodule", () => {
        const tempDir = mkdtempSync(path.join(tmpdir(), "skills-nested-"));
        const nestedDir = path.join(tempDir, "skills", "skills", "mantle-network-primer", "references");
        try {
            mkdirSync(nestedDir, { recursive: true });
            writeFileSync(path.join(nestedDir, "mantle-network-basics.md"), "# Mantle Network Basics\n\nNested layout.\n");
            expect(readSkillsReference("skills/mantle-network-primer/references/mantle-network-basics.md", tempDir)).toContain("Mantle Network Basics");
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
