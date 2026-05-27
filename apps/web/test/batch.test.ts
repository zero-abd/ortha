import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@ortha/contracts";
import { batchToCSV, collectRow, parseRows, runPool, type RowResult } from "../src/lib/batch.ts";

describe("parseRows", () => {
  it("treats each whole line as the value for a single-variable skill", () => {
    const rows = parseRows("stripe.com\nopenai.com", ["domain"]);
    expect(rows).toEqual([
      { line: "stripe.com", values: { domain: "stripe.com" }, cells: ["stripe.com"] },
      { line: "openai.com", values: { domain: "openai.com" }, cells: ["openai.com"] },
    ]);
  });

  it("keeps commas inside a single-variable value", () => {
    const rows = parseRows("Stripe, Inc.", ["company"]);
    expect(rows[0]!.values).toEqual({ company: "Stripe, Inc." });
  });

  it("splits comma-delimited cells across multiple variables in order", () => {
    const rows = parseRows("Stripe,payments\nOpenAI,ai", ["company", "sector"]);
    expect(rows[0]!.values).toEqual({ company: "Stripe", sector: "payments" });
    expect(rows[1]!.cells).toEqual(["OpenAI", "ai"]);
  });

  it("prefers tab delimiting when a tab is present (so values may contain commas)", () => {
    const rows = parseRows("Stripe, Inc.\tpayments", ["company", "sector"]);
    expect(rows[0]!.values).toEqual({ company: "Stripe, Inc.", sector: "payments" });
  });

  it("pads missing cells with empty strings and ignores extras", () => {
    const rows = parseRows("OnlyName", ["company", "sector"]);
    expect(rows[0]!.values).toEqual({ company: "OnlyName", sector: "" });
    const extra = parseRows("a,b,c", ["x", "y"]);
    expect(extra[0]!.cells).toEqual(["a", "b"]);
  });

  it("drops blank lines and trims surrounding whitespace", () => {
    const rows = parseRows("  stripe.com  \n\n   \nopenai.com\n", ["domain"]);
    expect(rows.map((r) => r.values.domain)).toEqual(["stripe.com", "openai.com"]);
  });
});

describe("collectRow", () => {
  it("concatenates streamed tokens into the answer and trims", () => {
    const events: TraceEvent[] = [
      { type: "token", text: "Patrick " },
      { type: "token", text: "Collison " },
      { type: "done", stopReason: "end" },
    ];
    expect(collectRow(events)).toEqual({ answer: "Patrick Collison", costCents: 0, ok: true });
  });

  it("sums cost only from successful tool results", () => {
    const events: TraceEvent[] = [
      { type: "tool_result", stepId: "s1", requestId: "r1", summary: "ok", priceCents: 3, latencyMs: 10, ok: true },
      { type: "tool_result", stepId: "s2", requestId: "r2", summary: "fail", priceCents: 5, latencyMs: 10, ok: false },
      { type: "token", text: "done" },
    ];
    const r = collectRow(events);
    expect(r.costCents).toBe(3);
    expect(r.ok).toBe(true);
  });

  it("captures the first error and marks the row failed", () => {
    const events: TraceEvent[] = [
      { type: "error", code: "TIMEOUT", message: "upstream slow" },
      { type: "error", code: "PROVIDER_DOWN", message: "later" },
    ];
    const r = collectRow(events);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("TIMEOUT: upstream slow");
  });
});

describe("runPool", () => {
  it("runs every item exactly once", async () => {
    const seen: number[] = [];
    await runPool([10, 20, 30, 40], async (n) => void seen.push(n), 2);
    expect(seen.sort((a, b) => a - b)).toEqual([10, 20, 30, 40]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await runPool(
      items,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
      3,
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually ran in parallel
  });

  it("handles an empty list without hanging", async () => {
    let ran = 0;
    await runPool([], async () => void ran++, 4);
    expect(ran).toBe(0);
  });
});

describe("batchToCSV", () => {
  it("emits variable columns plus result/cost/status with a header", () => {
    const rows: { cells: string[]; result?: RowResult }[] = [
      { cells: ["Stripe"], result: { answer: "Patrick Collison", costCents: 3, ok: true } },
      { cells: ["OpenAI"], result: { answer: "Sam Altman", costCents: 5, ok: true } },
    ];
    expect(batchToCSV(["company"], rows)).toBe(
      "company,result,cost_usd,status\nStripe,Patrick Collison,0.03,ok\nOpenAI,Sam Altman,0.05,ok",
    );
  });

  it("quotes fields containing commas, quotes, or newlines", () => {
    const rows = [{ cells: ["Stripe, Inc."], result: { answer: 'He said "hi"\nbye', costCents: 0, ok: true } }];
    const csv = batchToCSV(["company"], rows);
    expect(csv).toContain('"Stripe, Inc."');
    expect(csv).toContain('"He said ""hi""\nbye"');
  });

  it("renders pending rows and failures distinctly", () => {
    const rows: { cells: string[]; result?: RowResult }[] = [
      { cells: ["A"] },
      { cells: ["B"], result: { answer: "", costCents: 0, ok: false, error: "TIMEOUT: slow" } },
    ];
    const csv = batchToCSV(["x"], rows);
    expect(csv).toContain("A,,,pending");
    expect(csv).toContain("B,,0.00,TIMEOUT: slow");
  });
});
