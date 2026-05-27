import { describe, expect, it } from "vitest";
import { wrapResearch } from "../src/lib/research.ts";

describe("wrapResearch", () => {
  it("keeps the original question text in the wrapped prompt", () => {
    const out = wrapResearch("What is the GDP of France?");
    expect(out).toContain("What is the GDP of France?");
  });

  it("adds a research instruction with the web tools and citation directive", () => {
    const out = wrapResearch("compare EV battery chemistries").toLowerCase();
    expect(out).toContain("web_search");
    expect(out).toContain("web_scrape");
    // Pushes toward synthesis, citing sources, and flagging uncertainty.
    expect(out).toContain("cite");
    expect(out).toContain("uncertain");
  });

  it("is empty-safe — blank input returns an empty string", () => {
    expect(wrapResearch("")).toBe("");
    expect(wrapResearch("   ")).toBe("");
    expect(wrapResearch("\n\t ")).toBe("");
  });

  it("is idempotent-ish — wrapping an already-wrapped prompt does not double-wrap", () => {
    const once = wrapResearch("how do tariffs affect inflation?");
    const twice = wrapResearch(once);
    expect(twice).toBe(once);
    // The marker line appears exactly once.
    const markerCount = twice.split("[Deep research mode]").length - 1;
    expect(markerCount).toBe(1);
  });

  it("trims surrounding whitespace from the question", () => {
    const out = wrapResearch("  what is quantum supremacy?  ");
    expect(out).toContain("what is quantum supremacy?");
    expect(out).not.toContain("  what is quantum supremacy?  ");
  });
});
