import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("skills directory", () => {
  it("contains the mantle-openclaw-competition skill", () => {
    expect(existsSync("skills/mantle-openclaw-competition/SKILL.md")).toBe(true);

    const skill = readFileSync("skills/mantle-openclaw-competition/SKILL.md", "utf8");
    expect(skill).toContain("mantle-openclaw-competition");
  });

  it("documents the skill in the root README", () => {
    const readme = readFileSync("README.md", "utf8");

    expect(readme).toContain("mantle-openclaw-competition");
    expect(readme).toContain("skills/mantle-openclaw-competition/SKILL.md");
  });
});
