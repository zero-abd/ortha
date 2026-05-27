import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@ortha/contracts";
import { batchToCSV, collectRow, parseRows, runPool, skillPrompt, type RowResult } from "../src/lib/batch.ts";

describe("skillPrompt", () => {
  it("appends the trimmed input below the skill template", () => {
    expect(skillPrompt("Find the CEO.", "stripe.com")).toBe("Find the CEO.\n\nstripe.com");
    expect(skillPrompt("Find the CEO.", "  stripe.com  ")).toBe("Find the CEO.\n\nstripe.com");
  });

  it("returns the bare template when there is no input", () => {
    expect(skillPrompt("Find the CEO.", "")).toBe("Find the CEO.");
    expect(skillPrompt("Find the CEO.", "   ")).toBe("Find the CEO.");
  });
});

describe("parseRows", () => {
  it("treats each whole line as one input", () => {
    expect(parseRows("stripe.com\nopenai.com")).toEqual(["stripe.com", "openai.com"]);
  });

  it("keeps commas and punctuation inside a line (no field splitting)", () => {
    expect(parseRows("Stripe, Inc.\nOpenAI, the lab")).toEqual(["Stripe, Inc.", "OpenAI, the lab"]);
  });

  it("drops blank lines and trims surrounding whitespace", () => {
    expect(parseRows("  stripe.com  \n\n   \nopenai.com\n")).toEqual(["stripe.com", "openai.com"]);
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
  it("emits an input column plus result/cost/status with a header", () => {
    const rows: { input: string; result?: RowResult }[] = [
      { input: "Stripe", result: { answer: "Patrick Collison", costCents: 3, ok: true } },
      { input: "OpenAI", result: { answer: "Sam Altman", costCents: 5, ok: true } },
    ];
    expect(batchToCSV(rows)).toBe(
      "input,result,cost_usd,status\nStripe,Patrick Collison,0.03,ok\nOpenAI,Sam Altman,0.05,ok",
    );
  });

  it("quotes fields containing commas, quotes, or newlines", () => {
    const rows = [{ input: "Stripe, Inc.", result: { answer: 'He said "hi"\nbye', costCents: 0, ok: true } }];
    const csv = batchToCSV(rows);
    expect(csv).toContain('"Stripe, Inc."');
    expect(csv).toContain('"He said ""hi""\nbye"');
  });

  it("renders pending rows and failures distinctly", () => {
    const rows: { input: string; result?: RowResult }[] = [
      { input: "A" },
      { input: "B", result: { answer: "", costCents: 0, ok: false, error: "TIMEOUT: slow" } },
    ];
    const csv = batchToCSV(rows);
    expect(csv).toContain("A,,,pending");
    expect(csv).toContain("B,,0.00,TIMEOUT: slow");
  });
});
