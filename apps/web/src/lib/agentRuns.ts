// Agent-run state for the Agents activity panel.
//
// A "run" is one agent task — a chat turn or a batch row. Both stream the same
// TraceEvent union, so a single pure reducer folds those events into a run's
// trace + answer + cost. Keeping it pure (no React) makes the folding logic
// unit-testable and identical across the chat and batch code paths.

import type { TraceEvent } from "@ortha/contracts";
import type { AgentRun } from "../types.ts";

/** Start a fresh run in the "running" state. */
export function newAgentRun(id: string, title: string, kind: AgentRun["kind"]): AgentRun {
  return {
    id,
    title: title.trim().slice(0, 200) || "Untitled task",
    kind,
    status: "running",
    startedAt: Date.now(),
    costCents: 0,
    steps: [],
    answer: "",
  };
}

/**
 * Fold one streamed event into a run. Mirrors the inline chat trace exactly:
 * tokens append to the answer, searches/calls become steps, results update the
 * matching step and add successful spend, self_heal annotates a failed step, and
 * a hard error event is recorded. cost_update / done / permission events are
 * handled by the caller (lifecycle), so they pass through unchanged.
 */
export function applyTraceEventToRun(run: AgentRun, e: TraceEvent): AgentRun {
  switch (e.type) {
    case "token":
      return { ...run, answer: run.answer + e.text };
    case "tool_search":
      return {
        ...run,
        steps: [
          ...run.steps,
          { stepId: `search_${run.steps.length}`, api: "search_tools", path: `"${e.query}"`, status: "success", summary: `${e.resultCount} tools found` },
        ],
      };
    case "tool_call_started":
      return { ...run, steps: [...run.steps, { stepId: e.stepId, api: e.api, path: e.path, estCents: e.estCents, status: "running" }] };
    case "tool_result":
      return {
        ...run,
        costCents: run.costCents + (e.ok ? e.priceCents : 0),
        steps: run.steps.map((s) =>
          s.stepId === e.stepId
            ? { ...s, status: e.ok ? "success" : "failed", summary: e.summary, priceCents: e.priceCents, latencyMs: e.latencyMs, requestId: e.requestId }
            : s,
        ),
      };
    case "self_heal":
      return {
        ...run,
        steps: run.steps.map((s) => (s.api === e.failedProvider && s.status === "failed" && !s.heal ? { ...s, heal: { failed: e.failedProvider, alt: e.altProvider } } : s)),
      };
    case "error":
      return { ...run, error: `${e.code}: ${e.message}` };
    default:
      return run;
  }
}

/** Close a run, deriving its terminal status (an explicit override wins). */
export function finishRun(run: AgentRun, override?: { status?: AgentRun["status"]; error?: string }): AgentRun {
  const error = override?.error ?? run.error;
  const status = override?.status ?? (error ? "error" : "done");
  return { ...run, status, endedAt: Date.now(), ...(error ? { error } : {}) };
}
