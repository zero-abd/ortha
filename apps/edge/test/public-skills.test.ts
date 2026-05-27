import { describe, expect, it } from "vitest";
import { transformPublicSkills } from "../src/api.js";

/** Build a raw catalog skill with a SKILL.md (plus a noise file) the way upstream returns it. */
function rawSkill(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "id",
    userId: "u",
    name: "Skill",
    slug: "skill",
    description: "does a thing",
    highlighted: false,
    installCount: 0,
    verified: false,
    tags: ["a"],
    files: [
      { filePath: "README.md", content: "ignore me" },
      { filePath: "SKILL.md", content: "the body" },
    ],
    ...over,
  };
}

describe("transformPublicSkills", () => {
  it("returns an empty array for non-array / missing input", () => {
    expect(transformPublicSkills(null)).toEqual([]);
    expect(transformPublicSkills({})).toEqual([]);
    expect(transformPublicSkills({ skills: "nope" })).toEqual([]);
  });

  it("extracts SKILL.md content and the trimmed shape", () => {
    const out = transformPublicSkills({ skills: [rawSkill({ id: "x1", name: "Enrich", slug: "enrich", tags: ["lead", "crm"] })] });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: "x1",
      name: "Enrich",
      slug: "enrich",
      description: "does a thing",
      highlighted: false,
      installCount: 0,
      verified: false,
      tags: ["lead", "crm"],
      content: "the body",
    });
  });

  it("caps SKILL.md content at ~6000 chars", () => {
    const big = "x".repeat(7000);
    const out = transformPublicSkills({
      skills: [rawSkill({ files: [{ filePath: "SKILL.md", content: big }] })],
    });
    expect(out[0]!.content).toHaveLength(6000);
  });

  it("sorts featured first, then by installCount desc", () => {
    const out = transformPublicSkills({
      skills: [
        rawSkill({ id: "plain-low", highlighted: false, installCount: 5 }),
        rawSkill({ id: "feat-low", highlighted: true, installCount: 1 }),
        rawSkill({ id: "plain-high", highlighted: false, installCount: 99 }),
        rawSkill({ id: "feat-high", highlighted: true, installCount: 50 }),
      ],
    });
    expect(out.map((s) => s.id)).toEqual(["feat-high", "feat-low", "plain-high", "plain-low"]);
  });

  it("defaults content to empty string when there is no SKILL.md", () => {
    const out = transformPublicSkills({ skills: [rawSkill({ files: [{ filePath: "OTHER.md", content: "nope" }] })] });
    expect(out[0]!.content).toBe("");
  });

  it("tolerates missing/oddly-typed fields", () => {
    const out = transformPublicSkills({ skills: [{}, { tags: [1, "ok", null], installCount: "5", files: "bad" }] });
    expect(out).toHaveLength(2);
    // installCount is non-numeric → 0; both end up unfeatured so order is by installCount (both 0).
    expect(out.every((s) => s.installCount === 0)).toBe(true);
    expect(out[1]!.tags).toEqual(["ok"]);
    expect(out[0]!.content).toBe("");
  });
});
