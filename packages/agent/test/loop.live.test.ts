import {
  asConversationId,
  asWorkspaceId,
  type Cents,
  type LLMEvent,
  type LLMMessage,
  type LLMProvider,
  type StreamInput,
  type TraceEvent,
  type WorkspaceId,
} from "@ortha/contracts";
import { makeMockMemoryStore } from "@ortha/contracts/mocks";
import { createBudgetPolicy, InMemorySpendStore } from "@ortha/budget";
import { createOrthogonalClient } from "@ortha/harness";
import { describe, expect, it } from "vitest";
import { runAgentTurn, type AgentDeps } from "../src/loop.js";

// Full agent-loop integration against the REAL api.orthogonal.com. Drives the
// loop with a scripted LLM (no LLM provider key needed) but a REAL Orthogonal
// client and the REAL budget policy, so it proves the production path end to end:
// search (free) -> get_tool_details (free, prices the endpoint) -> run_tool (PAID
// ~$0.03) -> reserve/settle reconciliation against the real priceCents.
//
// SKIPPED unless ORTHO_TEST_KEY is set, because it spends real money:
//   ORTHO_TEST_KEY=orth_live_... bunx vitest run packages/agent/test/loop.live.test.ts
//
// Uses the cheapest scrape endpoint against example.com to keep the cost ~$0.02-0.03.

const KEY = process.env["ORTHO_TEST_KEY"];
const WS: WorkspaceId = asWorkspaceId("ws_live_test");
const CONV = asConversationId("conv_live_test");

// One streamCompletion call per array: search -> details -> run -> final answer.
function scriptedLLM(turns: readonly (readonly LLMEvent[])[]): LLMProvider {
  let turn = 0;
  return {
    id: "anthropic",
    async *streamCompletion(_input: StreamInput): AsyncIterable<LLMEvent> {
      const events = turns[turn] ?? [{ type: "done", stopReason: "end" }];
      turn += 1;
      for (const e of events) yield e;
    },
  };
}

describe.skipIf(!KEY)("live agent loop against real Orthogonal API", () => {
  it("discovers a tool, prices it, runs it, and reconciles real spend", async () => {
    const store = new InMemorySpendStore(() => 10_000 as Cents);
    const budget = createBudgetPolicy({
      store,
      // Caps high enough that the cheap call neither crosses the session cap nor
      // trips the per-call warn — we are testing the spend path, not the gate.
      settings: { sessionCapCents: 10_000 as Cents, monthlyCapCents: 100_000 as Cents, perCallWarnCents: 10_000 as Cents },
    });

    const deps: AgentDeps = {
      llm: scriptedLLM([
        [{ type: "tool_call_request", id: "c1", name: "search_tools", args: { query: "scrape a webpage to markdown" } }, { type: "done", stopReason: "tool_use" }],
        [{ type: "tool_call_request", id: "c2", name: "get_tool_details", args: { api: "context-dev", path: "/web/scrape/markdown" } }, { type: "done", stopReason: "tool_use" }],
        [{ type: "tool_call_request", id: "c3", name: "run_tool", args: { api: "context-dev", path: "/web/scrape/markdown", query: { url: "https://example.com" } } }, { type: "done", stopReason: "tool_use" }],
        [{ type: "token", text: "Scraped the page." }, { type: "done", stopReason: "end" }],
      ]),
      orthogonal: createOrthogonalClient({ getApiKey: async () => KEY! }),
      budget,
      memory: makeMockMemoryStore(),
      model: "scripted",
      workspaceId: WS,
      conversationId: CONV,
      requestPermission: async () => ({ stepId: "x", decision: "approve" }),
      checkpoint: async () => undefined,
    };

    const events: TraceEvent[] = [];
    for await (const e of runAgentTurn(deps, { messages: [{ role: "user", content: "scrape example.com" } as LLMMessage] })) {
      events.push(e);
    }

    // No errors anywhere in the stream.
    expect(events.find((e) => e.type === "error")).toBeUndefined();

    // The tool ran and reported a real price.
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.ok).toBe(true);
      expect(toolResult.priceCents).toBeGreaterThan(0);
    }

    // Cost was reconciled: session spend equals the real settled price.
    const cost = events.filter((e) => e.type === "cost_update").at(-1);
    expect(cost).toBeDefined();
    if (cost?.type === "cost_update") {
      expect(cost.sessionCents).toBeGreaterThan(0);
      const settled = await store.sessionSpent(CONV);
      expect(settled).toBe(cost.sessionCents);
    }

    // The turn finished cleanly.
    expect(events.at(-1)?.type).toBe("done");
  }, 30_000);
});
