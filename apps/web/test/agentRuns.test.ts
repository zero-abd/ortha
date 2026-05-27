import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@ortha/contracts";
import { applyTraceEventToRun, finishRun, newAgentRun } from "../src/lib/agentRuns.ts";

const fold = (events: TraceEvent[]) => events.reduce(applyTraceEventToRun, newAgentRun("r1", "Who is the CEO of Stripe?", "chat"));

describe("newAgentRun", () => {
  it("starts running with an empty trace and trims/falls back the title", () => {
    const r = newAgentRun("r1", "  ", "batch");
    expect(r).toMatchObject({ id: "r1", title: "Untitled task", kind: "batch", status: "running", costCents: 0, answer: "", steps: [] });
  });
});

describe("applyTraceEventToRun", () => {
  it("appends streamed tokens to the answer", () => {
    const r = fold([
      { type: "token", text: "Patrick " },
      { type: "token", text: "Collison." },
    ]);
    expect(r.answer).toBe("Patrick Collison.");
  });

  it("records a search as a success step", () => {
    const r = fold([{ type: "tool_search", query: "stripe ceo", resultCount: 4 }]);
    expect(r.steps[0]).toMatchObject({ api: "search_tools", path: '"stripe ceo"', status: "success", summary: "4 tools found" });
  });

  it("turns a started call into a running step, then the result completes it and adds cost", () => {
    const r = fold([
      { type: "tool_call_started", stepId: "step_1", api: "crustdata", path: "/screener/company", estCents: 22 },
      { type: "tool_result", stepId: "step_1", requestId: "req_1", summary: "Stripe — fintech", priceCents: 31, latencyMs: 950, ok: true },
    ]);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toMatchObject({ stepId: "step_1", api: "crustdata", status: "success", priceCents: 31, latencyMs: 950, requestId: "req_1" });
    expect(r.costCents).toBe(31);
  });

  it("marks a failed result without adding its price to cost", () => {
    const r = fold([
      { type: "tool_call_started", stepId: "step_1", api: "aviato", path: "/company/founders", estCents: 2 },
      { type: "tool_result", stepId: "step_1", requestId: "failed_step_1", summary: "failed — NOT_FOUND: 404", priceCents: 0, latencyMs: 120, ok: false },
    ]);
    expect(r.steps[0]).toMatchObject({ status: "failed" });
    expect(r.costCents).toBe(0);
  });

  it("annotates a failed step with self-heal info", () => {
    const r = fold([
      { type: "tool_call_started", stepId: "step_1", api: "apollo", path: "/x", estCents: 3 },
      { type: "tool_result", stepId: "step_1", requestId: "r", summary: "down", priceCents: 0, latencyMs: 10, ok: false },
      { type: "self_heal", failedProvider: "apollo", altProvider: "apollo" },
    ]);
    expect(r.steps[0]!.heal).toEqual({ failed: "apollo", alt: "apollo" });
  });

  it("records an error event", () => {
    const r = fold([{ type: "error", code: "PROVIDER_DOWN", message: "apollo is down" }]);
    expect(r.error).toBe("PROVIDER_DOWN: apollo is down");
  });

  it("ignores lifecycle events (cost_update / done / permission)", () => {
    const before = newAgentRun("r1", "x", "chat");
    const after = applyTraceEventToRun(before, { type: "done", stopReason: "end" });
    expect(after).toEqual(before);
  });
});

describe("finishRun", () => {
  it("derives done when there is no error", () => {
    const r = finishRun(newAgentRun("r1", "x", "chat"));
    expect(r.status).toBe("done");
    expect(r.endedAt).toBeTypeOf("number");
  });

  it("derives error when the run captured one", () => {
    const errored = applyTraceEventToRun(newAgentRun("r1", "x", "chat"), { type: "error", code: "TIMEOUT", message: "slow" });
    expect(finishRun(errored).status).toBe("error");
  });

  it("honors an explicit status/error override", () => {
    const r = finishRun(newAgentRun("r1", "x", "batch"), { status: "error", error: "run failed" });
    expect(r).toMatchObject({ status: "error", error: "run failed" });
  });
});
