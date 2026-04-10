import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("skills submodule integration", () => {
    it("tracks mantle-skills via git submodule metadata", () => {
        const gitmodules = readFileSync(".gitmodules", "utf8");
        expect(gitmodules).toContain('[submodule "skills"]');
        expect(gitmodules).toContain("path = skills");
        expect(gitmodules).toContain("url = https://github.com/mantle-xyz/mantle-skills.git");
        expect(gitmodules).toContain("branch = main");
    });
    it("documents init and sync commands for the external skills checkout", () => {
        const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
        const readme = readFileSync("README.md", "utf8");
        const skillsPage = readFileSync("docs/content/concepts/skills.mdx", "utf8");
        const externalAgentsPage = readFileSync("docs/content/concepts/external-agents.mdx", "utf8");
        expect(packageJson.scripts?.["skills:init"]).toBeDefined();
        expect(packageJson.scripts?.["skills:sync"]).toBeDefined();
        expect(readme).toContain("mantle-xyz/mantle-skills");
        expect(readme).toContain("npm run skills:init");
        expect(readme).toContain("npm run skills:sync");
        expect(readme).toContain("skills/skills/<skill-name>/SKILL.md");
        expect(skillsPage).toContain("mantle-xyz/mantle-skills");
        expect(skillsPage).toContain("mantle-skills");
        expect(skillsPage).toContain("skills/skills/<skill-name>/SKILL.md");
        expect(externalAgentsPage).toContain("mantle-xyz/mantle-skills");
        expect(externalAgentsPage).toContain("npm run skills:init");
        expect(externalAgentsPage).toContain("skills/skills/<skill-name>/SKILL.md");
    });
});
