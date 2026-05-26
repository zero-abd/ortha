import { describe, expect, it } from "vitest";
import { distill } from "../src/distill.js";

// Structure-aware distillation — each test mirrors a real provider shape the live
// probes captured, where the scalar-only fallback would have lost the answer.

describe("distill — passthrough", () => {
  it("returns small JSON untouched", () => {
    const d = distill({ a: 1, b: "two" });
    expect(d.truncated).toBe(false);
    expect(d.kind).toBe("passthrough");
    expect(d.summary).toBe(JSON.stringify({ a: 1, b: "two" }));
    expect(d.rawBytes).toBe(JSON.stringify({ a: 1, b: "two" }).length);
  });
});

describe("distill — list (search results)", () => {
  // serper-like: the answer is the `organic` array; the old code kept only `credits:1`.
  const serper = {
    searchParameters: { q: "best crm" },
    answerBox: { answer: "Salesforce is widely considered the leading CRM." },
    organic: Array.from({ length: 10 }, (_, i) => ({
      title: `Result ${i} — Top CRM Platform`,
      link: `https://example.com/crm/${i}`,
      snippet: "A".repeat(400),
      position: i + 1,
    })),
    credits: 1,
  };

  it("describes the collection with count and item previews", () => {
    const d = distill(serper, 800);
    expect(d.truncated).toBe(true);
    expect(d.kind).toBe("list");
    expect(d.count).toBe(10);
    expect(d.summary).toContain("[10 items]");
    // Salient item content survives.
    expect(d.summary).toContain("Result 0 — Top CRM Platform");
    expect(d.summary).toContain("https://example.com/crm/0");
    // Default preview is 5 items.
    expect(d.preview).toHaveLength(5);
    // Snippets are trimmed, not dumped whole.
    expect(d.summary).not.toContain("A".repeat(400));
    // Bounded.
    expect(d.summary.length).toBeLessThanOrEqual(800);
  });

  it("keeps top-level answer-engine scalars alongside the list", () => {
    // answer is gold: a flat-scalar `answer` next to results.
    const ae = {
      query: "who founded stripe",
      answer: "Patrick Collison and John Collison founded Stripe in 2010.",
      results: Array.from({ length: 6 }, (_, i) => ({
        title: `Source ${i}`,
        url: `https://src/${i}`,
        snippet: "context " + "z".repeat(300),
      })),
    };
    const d = distill(ae, 800);
    expect(d.summary).toContain("answer:");
    expect(d.summary).toContain("Patrick Collison");
    expect(d.summary).toContain("query:");
    expect(d.scalars?.answer).toContain("Patrick Collison");
  });
});

describe("distill — envelopes", () => {
  it("unwraps a lone `data` object envelope and records the path", () => {
    const payload = {
      data: {
        name: "Stripe",
        ceo: "Patrick Collison",
        description: "D".repeat(2000),
      },
    };
    const d = distill(payload, 300);
    expect(d.truncated).toBe(true);
    expect(d.summary).toContain("data:");
    expect(d.summary).toContain("name: Stripe");
    expect(d.summary.length).toBeLessThanOrEqual(300);
  });

  it("unwraps a lone `output` array envelope into a list", () => {
    const payload = {
      output: Array.from({ length: 8 }, (_, i) => ({
        name: `Person ${i}`,
        website: `https://p/${i}`,
        bio: "B".repeat(250),
      })),
    };
    const d = distill(payload, 800);
    expect(d.kind).toBe("list");
    expect(d.count).toBe(8);
    expect(d.summary).toContain("output:");
    expect(d.summary).toContain("[8 items]");
    expect(d.summary).toContain("Person 0");
  });

  it("descends nested `result` -> `documents` envelopes", () => {
    const payload = {
      result: {
        documents: Array.from({ length: 12 }, (_, i) => ({
          title: `Doc ${i}`,
          url: `https://d/${i}`,
          content: "C".repeat(500),
        })),
      },
    };
    const d = distill(payload, 800);
    expect(d.kind).toBe("list");
    expect(d.count).toBe(12);
    expect(d.summary).toContain("Doc 0");
    expect(d.summary.length).toBeLessThanOrEqual(800);
  });
});

describe("distill — bare-root array", () => {
  it("treats a bare array of objects as the collection", () => {
    const arr = Array.from({ length: 20 }, (_, i) => ({
      name: `Company ${i}`,
      domain: `company${i}.com`,
      description: "X".repeat(200),
    }));
    const d = distill(arr, 800);
    expect(d.kind).toBe("list");
    expect(d.count).toBe(20);
    expect(d.summary).toContain("[20 items]");
    expect(d.summary).toContain("Company 0");
    expect(d.summary).toContain("company0.com");
    expect(d.summary.length).toBeLessThanOrEqual(800);
  });
});

describe("distill — time-series numeric array", () => {
  it("summarizes a long numeric array with stats and a sample", () => {
    // dome-like 100-point history; old code yielded `total:100` and lost the curve.
    // maxChars=200 so the ~600-byte series exceeds the passthrough threshold.
    const series = Array.from({ length: 100 }, (_, i) => i * 1.5);
    const d = distill(series, 200);
    expect(d.kind).toBe("series");
    expect(d.count).toBe(100);
    expect(d.summary).toContain("series[100]");
    expect(d.summary).toContain("first=0");
    expect(d.summary).toContain("last=148.5");
    expect(d.summary).toContain("min=0");
    expect(d.summary).toContain("max=148.5");
    expect(d.summary).toContain("mean=");
    expect(d.summary).toContain("sample=");
    expect(d.summary.length).toBeLessThanOrEqual(800);
  });
});

describe("distill — plain object (no collection)", () => {
  it("surfaces top-level scalars (preserves the legacy contract)", () => {
    const big = { name: "Stripe", ceo: "Patrick", blob: "x".repeat(5000) };
    const d = distill(big, 200);
    expect(d.truncated).toBe(true);
    expect(d.rawBytes).toBeGreaterThan(200);
    expect(d.summary).toContain("name: Stripe");
    expect(d.kind).toBe("object");
  });

  it("recurses one level into the largest nested object", () => {
    const payload = {
      status: "ok",
      meta: { requestId: "r1" },
      company: {
        legalName: "Stripe, Inc.",
        employees: 8000,
        notes: "N".repeat(3000),
      },
    };
    const d = distill(payload, 400);
    expect(d.kind).toBe("object");
    expect(d.summary).toContain("status: ok");
    // The buried scalar from the largest nested object is surfaced with a path.
    expect(d.summary).toContain("company.legalName: Stripe, Inc.");
    expect(d.summary.length).toBeLessThanOrEqual(400);
  });
});

describe("distill — scalar / string root", () => {
  it("head+tail slices a long string root", () => {
    const long = "START_" + "m".repeat(4000) + "_END";
    const d = distill(long, 120);
    expect(d.kind).toBe("scalar");
    expect(d.truncated).toBe(true);
    expect(d.summary.length).toBeLessThanOrEqual(120);
    expect(d.summary.startsWith("START_")).toBe(true);
    expect(d.summary.endsWith("_END")).toBe(true);
  });
});

describe("distill — huge payload stays bounded", () => {
  it("bounds a >100KB list payload while reporting large rawBytes", () => {
    const huge = {
      results: Array.from({ length: 2000 }, (_, i) => ({
        title: `Item ${i}`,
        url: `https://huge.example.com/item/${i}`,
        snippet: "lorem ipsum dolor sit amet ".repeat(20),
      })),
      credits: 5,
    };
    const d = distill(huge, 1000);
    expect(d.rawBytes).toBeGreaterThan(100_000);
    expect(d.truncated).toBe(true);
    expect(d.kind).toBe("list");
    expect(d.count).toBe(2000);
    // Summary is bounded to ~1KB regardless of the 100KB+ input.
    expect(d.summary.length).toBeLessThanOrEqual(1000);
    expect(d.summary).toContain("[2000 items]");
    expect(d.summary).toContain("Item 0");
  });

  it("bounds a deeply nested non-collection object (>100KB)", () => {
    const deep: Record<string, unknown> = { status: "ok" };
    deep.payload = { level1: { level2: { blob: "q".repeat(200_000) } } };
    const d = distill(deep, 800);
    expect(d.rawBytes).toBeGreaterThan(100_000);
    expect(d.truncated).toBe(true);
    expect(d.summary).toContain("status: ok");
    expect(d.summary.length).toBeLessThanOrEqual(800);
    expect(typeof d.summary).toBe("string");
    expect(d.summary.length).toBeGreaterThan(0);
  });
});
