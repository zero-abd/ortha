import {
  asConversationId,
  asWorkspaceId,
  ErrorCode,
  OrthaError,
  type BudgetDecision,
  type BudgetPolicy,
  type LLMEvent,
  type LLMMessage,
  type LLMProvider,
  type PermissionResponse,
  type ReservationId,
  type StreamInput,
  type TraceEvent,
  type WebPage,
} from "@ortha/contracts";
import {
  makeMockBudgetPolicy,
  makeMockMemoryStore,
  makeMockOrthogonalClient,
  makeMockWebClient,
} from "@ortha/contracts/mocks";
import { describe, expect, it, vi } from "vitest";
import { runAgentTurn, type AgentDeps } from "../src/loop.js";

const WS = asWorkspaceId("ws_1");
const CONV = asConversationId("conv_1");

/**
 * A turn-scripted LLM: each entry in `turns` is the full event sequence for one
 * `streamCompletion` call. Lets us script "request a tool, then answer".
 */
function makeTurnScriptedLLM(turns: readonly (readonly LLMEvent[])[]): LLMProvider {
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

const USER: LLMMessage = { role: "user", content: "Who is the CEO of Stripe?" };

function baseDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
  return {
    llm: makeTurnScriptedLLM([]),
    orthogonal: makeMockOrthogonalClient(),
    web: makeMockWebClient(),
    budget: makeMockBudgetPolicy(),
    memory: makeMockMemoryStore(),
    model: "gemini-flash",
    workspaceId: WS,
    conversationId: CONV,
    requestPermission: async () => ({ stepId: "x", decision: "approve" }),
    checkpoint: async () => undefined,
    ...overrides,
  };
}

async function collect(deps: AgentDeps, input = { messages: [USER] }): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  for await (const e of runAgentTurn(deps, input)) events.push(e);
  return events;
}

const RUN_CALL: LLMEvent = {
  type: "tool_call_request",
  id: "call_1",
  name: "run_tool",
  args: { api: "apollo", path: "/v1/people/match", body: { domain: "stripe.com" } },
};

describe("runAgentTurn — direct answer", () => {
  it("relays tokens and ends with done when the model uses no tools", async () => {
    const llm = makeTurnScriptedLLM([
      [
        { type: "token", text: "The CEO " },
        { type: "token", text: "is Patrick Collison." },
        { type: "usage", inputTokens: 10, outputTokens: 6 },
        { type: "done", stopReason: "end" },
      ],
    ]);
    const events = await collect(baseDeps({ llm }));

    const tokens = events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text);
    expect(tokens.join("")).toBe("The CEO is Patrick Collison.");

    const last = events.at(-1);
    expect(last).toEqual({ type: "done", stopReason: "end" });
  });

  it("checkpoints the turn", async () => {
    const checkpoint = vi.fn(async () => undefined);
    const llm = makeTurnScriptedLLM([[{ type: "token", text: "hi" }, { type: "done", stopReason: "end" }]]);
    await collect(baseDeps({ llm, checkpoint }));
    expect(checkpoint).toHaveBeenCalled();
  });
});

describe("runAgentTurn — one run_tool then answer", () => {
  it("reserves+settles, emits started/result/cost_update, then the final answer", async () => {
    const budget = makeMockBudgetPolicy();
    const reserveSpy = vi.spyOn(budget, "reserve");
    const settleSpy = vi.spyOn(budget, "settle");

    const llm = makeTurnScriptedLLM([
      [RUN_CALL, { type: "done", stopReason: "tool_use" }],
      [
        { type: "token", text: "Patrick Collison is the CEO." },
        { type: "done", stopReason: "end" },
      ],
    ]);

    const events = await collect(baseDeps({ llm, budget }));
    const types = events.map((e) => e.type);

    expect(reserveSpy).toHaveBeenCalledOnce();
    expect(settleSpy).toHaveBeenCalledOnce();
    expect(types).toContain("tool_call_started");
    expect(types).toContain("tool_result");
    expect(types).toContain("cost_update");

    const started = events.find((e) => e.type === "tool_call_started");
    expect(started).toMatchObject({ api: "apollo", path: "/v1/people/match", estCents: 3 });

    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ priceCents: 3, ok: true });

    // Order: started precedes result precedes cost_update.
    expect(types.indexOf("tool_call_started")).toBeLessThan(types.indexOf("tool_result"));
    expect(types.indexOf("tool_result")).toBeLessThan(types.indexOf("cost_update"));

    // Final answer tokens follow the tool round-trip, then done.
    const tokenText = events
      .filter((e) => e.type === "token")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(tokenText).toBe("Patrick Collison is the CEO.");
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end" });
  });

  it("derives a stable idempotency key incorporating the step", async () => {
    const seenKeys: string[] = [];
    const orthogonal = makeMockOrthogonalClient({
      async run(input) {
        seenKeys.push(input.idempotencyKey);
        return { success: true, priceCents: 3, data: { ok: true }, requestId: "run_x" as never };
      },
    });
    const llm = makeTurnScriptedLLM([
      [RUN_CALL, { type: "done", stopReason: "tool_use" }],
      [{ type: "token", text: "done" }, { type: "done", stopReason: "end" }],
    ]);
    await collect(baseDeps({ llm, orthogonal }));
    expect(seenKeys).toHaveLength(1);
    expect(seenKeys[0]).toContain("apollo");
    expect(seenKeys[0]).toContain("step_");
  });
});

describe("runAgentTurn — permission gate", () => {
  function gatingBudget(): BudgetPolicy {
    const base = makeMockBudgetPolicy();
    return {
      ...base,
      async checkEstimate(): Promise<BudgetDecision> {
        return {
          decision: "permission_required",
          reason: "single call exceeds per-call warn threshold",
          sessionSpentCents: 50,
          sessionCapCents: 100,
          workspaceRemainingCents: 9_950,
        };
      },
    };
  }

  it("emits permission_required and honors approve", async () => {
    const budget = gatingBudget();
    const requestPermission = vi.fn(
      async (): Promise<PermissionResponse> => ({ stepId: "x", decision: "approve" }),
    );
    const llm = makeTurnScriptedLLM([
      [RUN_CALL, { type: "done", stopReason: "tool_use" }],
      [{ type: "token", text: "ok" }, { type: "done", stopReason: "end" }],
    ]);

    const events = await collect(baseDeps({ llm, budget, requestPermission }));
    const types = events.map((e) => e.type);

    expect(requestPermission).toHaveBeenCalledOnce();
    const gate = events.find((e) => e.type === "permission_required");
    expect(gate).toMatchObject({ kind: "cost", estCents: 3, capCents: 100 });
    expect(types).toContain("permission_resolved");
    // Approval lets the call proceed.
    expect(types).toContain("tool_call_started");
    expect(types).toContain("tool_result");
  });

  it("forces a cost gate when pricing is dynamic, even though the budget check passes", async () => {
    // Default budget is well within cap → "ok". The gate must come from the estimate
    // being a floor (dynamic pricing), so a "watch it spend" user explicitly approves.
    const orthogonal = makeMockOrthogonalClient({
      async estimateCost(plan) {
        const breakdown = plan.map((s) => ({ api: s.api, path: s.path, cents: 3 * s.expectedCalls, dynamic: true }));
        return {
          estimatedCents: breakdown.reduce((a, b) => a + b.cents, 0),
          breakdown,
          hasUnknownPrices: false,
          hasDynamicPricing: true,
        };
      },
    });
    const requestPermission = vi.fn(
      async (): Promise<PermissionResponse> => ({ stepId: "x", decision: "approve" }),
    );
    const llm = makeTurnScriptedLLM([
      [RUN_CALL, { type: "done", stopReason: "tool_use" }],
      [{ type: "token", text: "ok" }, { type: "done", stopReason: "end" }],
    ]);

    const events = await collect(baseDeps({ llm, orthogonal, requestPermission }));
    expect(requestPermission).toHaveBeenCalledOnce();
    const gate = events.find((e) => e.type === "permission_required");
    expect(gate).toMatchObject({ kind: "cost", dynamic: true });
    // Approval still lets the paid call proceed end-to-end.
    expect(events.some((e) => e.type === "tool_call_started")).toBe(true);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
  });

  it("does NOT gate a static-priced call that fits the budget", async () => {
    // Regression guard: the dynamic-pricing gate must not fire on ordinary calls.
    const requestPermission = vi.fn(
      async (): Promise<PermissionResponse> => ({ stepId: "x", decision: "approve" }),
    );
    const llm = makeTurnScriptedLLM([
      [RUN_CALL, { type: "done", stopReason: "tool_use" }],
      [{ type: "token", text: "ok" }, { type: "done", stopReason: "end" }],
    ]);
    const events = await collect(baseDeps({ llm, requestPermission }));
    expect(requestPermission).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "permission_required")).toBe(false);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
  });

  it("skip feeds a skipped result and never calls the tool", async () => {
    const budget = gatingBudget();
    const runSpy = vi.fn();
    const orthogonal = makeMockOrthogonalClient({
      async run(input) {
        runSpy();
        return { success: true, priceCents: 3, data: {}, requestId: "r" as never, _i: input } as never;
      },
    });
    const requestPermission = async (): Promise<PermissionResponse> => ({ stepId: "x", decision: "skip" });
    const llm = makeTurnScriptedLLM([
      [RUN_CALL, { type: "done", stopReason: "tool_use" }],
      [{ type: "token", text: "moving on" }, { type: "done", stopReason: "end" }],
    ]);

    const events = await collect(baseDeps({ llm, budget, orthogonal, requestPermission }));
    expect(runSpy).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "tool_call_started")).toBe(false);
    // The turn still resolves to a final answer.
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end" });
  });

  it("cancel ends the turn", async () => {
    const budget = gatingBudget();
    const requestPermission = async (): Promise<PermissionResponse> => ({ stepId: "x", decision: "cancel" });
    const llm = makeTurnScriptedLLM([[RUN_CALL, { type: "done", stopReason: "tool_use" }]]);

    const events = await collect(baseDeps({ llm, budget, requestPermission }));
    expect(events.some((e) => e.type === "permission_resolved")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end" });
  });

  it("escalates a write endpoint to the side_effect confirmation gate", async () => {
    // getDetails reports a write; the loop must gate the subsequent run behind the modal.
    const orthogonal = makeMockOrthogonalClient({
      async getDetails(api, path) {
        return {
          api,
          path,
          method: "POST",
          inputSchema: null,
          outputSchema: null,
          priceCents: 3,
          hasDynamicPricing: false,
          verified: true,
          sideEffect: "write",
        };
      },
    });
    const requestPermission = vi.fn(
      async (): Promise<PermissionResponse> => ({ stepId: "x", decision: "approve" }),
    );
    const llm = makeTurnScriptedLLM([
      [{ type: "tool_call_request", id: "d1", name: "get_tool_details", args: { api: "apollo", path: "/v1/people/match" } }, { type: "done", stopReason: "tool_use" }],
      [RUN_CALL, { type: "done", stopReason: "tool_use" }],
      [{ type: "token", text: "done" }, { type: "done", stopReason: "end" }],
    ]);

    const events = await collect(baseDeps({ llm, orthogonal, requestPermission }));
    const gate = events.find((e) => e.type === "permission_required");
    expect(gate).toMatchObject({ kind: "side_effect" });
    expect((gate as { action?: string }).action).toContain("apollo");
    expect(requestPermission).toHaveBeenCalledOnce();
    // Confirmed → the call proceeds to a result.
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
  });

  it("does NOT gate a read endpoint that fits the budget", async () => {
    // Default mock getDetails reports a read; no side_effect modal, no cost chip.
    const requestPermission = vi.fn(
      async (): Promise<PermissionResponse> => ({ stepId: "x", decision: "approve" }),
    );
    const llm = makeTurnScriptedLLM([
      [{ type: "tool_call_request", id: "d1", name: "get_tool_details", args: { api: "apollo", path: "/v1/people/match" } }, { type: "done", stopReason: "tool_use" }],
      [RUN_CALL, { type: "done", stopReason: "tool_use" }],
      [{ type: "token", text: "done" }, { type: "done", stopReason: "end" }],
    ]);
    const events = await collect(baseDeps({ llm, requestPermission }));
    expect(events.some((e) => e.type === "permission_required")).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
  });

  it("refuses to auto-run a long-running endpoint — no paid call", async () => {
    const runSpy = vi.fn();
    const orthogonal = makeMockOrthogonalClient({
      async getDetails(api, path) {
        return {
          api,
          path,
          method: "POST",
          inputSchema: null,
          outputSchema: null,
          priceCents: 10,
          hasDynamicPricing: false,
          verified: true,
          sideEffect: "read",
          longRunning: true,
        };
      },
      async run(input) {
        runSpy();
        return { success: true, priceCents: 10, data: {}, requestId: "r" as never, _i: input } as never;
      },
    });
    const llm = makeTurnScriptedLLM([
      [{ type: "tool_call_request", id: "d1", name: "get_tool_details", args: { api: "crawler", path: "/crawl" } }, { type: "done", stopReason: "tool_use" }],
      [{ type: "tool_call_request", id: "r1", name: "run_tool", args: { api: "crawler", path: "/crawl", body: { url: "https://x.com" } } }, { type: "done", stopReason: "tool_use" }],
      [{ type: "token", text: "I'll use a synchronous tool instead." }, { type: "done", stopReason: "end" }],
    ]);
    const events = await collect(baseDeps({ llm, orthogonal }));
    expect(runSpy).not.toHaveBeenCalled(); // never made the paid long-op call
    expect(events.some((e) => e.type === "tool_call_started")).toBe(false);
    expect(events.some((e) => e.type === "permission_required")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end" });
  });

  it("denied emits a BUDGET_EXCEEDED error and stops", async () => {
    const budget: BudgetPolicy = {
      ...makeMockBudgetPolicy(),
      async checkEstimate(): Promise<BudgetDecision> {
        return {
          decision: "denied",
          reason: "would exceed workspace cap",
          sessionSpentCents: 100,
          sessionCapCents: 100,
          workspaceRemainingCents: 0,
        };
      },
    };
    const llm = makeTurnScriptedLLM([[RUN_CALL, { type: "done", stopReason: "tool_use" }]]);
    const events = await collect(baseDeps({ llm, budget }));
    const err = events.find((e) => e.type === "error");
    expect(err).toMatchObject({ code: ErrorCode.BUDGET_EXCEEDED });
  });
});

describe("runAgentTurn — provider error", () => {
  it("feeds a failed tool call back to the model instead of aborting the turn", async () => {
    const orthogonal = makeMockOrthogonalClient({
      async run() {
        throw new OrthaError(ErrorCode.PROVIDER_DOWN, "apollo is down", {
          providerSlug: "apollo",
          retryable: true,
        });
      },
    });
    const llm = makeTurnScriptedLLM([
      [RUN_CALL, { type: "done", stopReason: "tool_use" }],
      // After the failed call is fed back, the model recovers with an answer.
      [{ type: "token", text: "Sorry, I couldn't reach that source." }, { type: "done", stopReason: "end" }],
    ]);
    const events = await collect(baseDeps({ llm, orthogonal }));
    const types = events.map((e) => e.type);

    // A retryable failure still emits a self_heal stub.
    expect(types).toContain("self_heal");
    // The failure surfaces as a failed tool_result (not a turn-ending error event)...
    const failed = events.find((e) => e.type === "tool_result" && (e as { ok: boolean }).ok === false);
    expect(failed).toBeTruthy();
    expect((failed as { summary: string }).summary).toContain("PROVIDER_DOWN");
    expect(types).not.toContain("error");
    // ...and the turn continues to a real answer rather than aborting empty.
    const tokens = events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("");
    expect(tokens).toContain("couldn't reach");
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end" });
  });
});

describe("runAgentTurn — tool_search", () => {
  it("emits tool_search and feeds results back", async () => {
    const llm = makeTurnScriptedLLM([
      [
        { type: "tool_call_request", id: "c1", name: "search_tools", args: { query: "enrich company" } },
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "token", text: "Found a tool." }, { type: "done", stopReason: "end" }],
    ]);
    const events = await collect(baseDeps({ llm }));
    const search = events.find((e) => e.type === "tool_search");
    expect(search).toMatchObject({ query: "enrich company", resultCount: 1 });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end" });
  });
});

describe("runAgentTurn — continue after narrated intent", () => {
  it("nudges the model to act when it narrates a next tool step without calling it", async () => {
    const onMessage = vi.fn(async () => undefined);
    const llm = makeTurnScriptedLLM([
      // turn 1: a result lacked the answer; the model narrates intent, no tool call.
      [{ type: "token", text: "That didn't include the CEO. I will search for another tool." }, { type: "done", stopReason: "end" }],
      // turn 2 (after the nudge): it actually searches.
      [{ type: "tool_call_request", id: "s1", name: "search_tools", args: { query: "company leadership" } }, { type: "done", stopReason: "tool_use" }],
      // turn 3: it answers.
      [{ type: "token", text: "Patrick Collison is the CEO." }, { type: "done", stopReason: "end" }],
    ]);
    const events = await collect(baseDeps({ llm, onMessage }));

    // It did NOT stop after the narrated-intent turn: a search happened and an answer followed.
    expect(events.some((e) => e.type === "tool_search")).toBe(true);
    const tokens = events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("");
    expect(tokens).toContain("Patrick Collison is the CEO.");
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end" });

    // The synthetic nudge is never persisted to the transcript (no user-role onMessage with it).
    const persistedNudge = onMessage.mock.calls.some(
      ([m]) => (m as LLMMessage).role === "user" && (m as LLMMessage).content.includes("Continue now"),
    );
    expect(persistedNudge).toBe(false);
  });

  it("stops after the auto-continue cap if the model keeps narrating intent", async () => {
    const intent: LLMEvent[] = [
      { type: "token", text: "Let me search for another tool to find it." },
      { type: "done", stopReason: "end" },
    ];
    const llm = makeTurnScriptedLLM([intent, intent, intent, intent, intent]);
    const events = await collect(baseDeps({ llm }));

    // Initial turn + 2 nudged turns = 3 streamed turns, then it gives up. One done, no loop.
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(events.some((e) => e.type === "tool_search")).toBe(false);
    const intentCount = events.filter(
      (e) => e.type === "token" && (e as { text: string }).text.includes("Let me search"),
    ).length;
    expect(intentCount).toBe(3);
  });

  it("does not nudge on a normal final answer with a closing offer", async () => {
    const llm = makeTurnScriptedLLM([
      [{ type: "token", text: "Patrick Collison is the CEO. Let me know if you want recent news." }, { type: "done", stopReason: "end" }],
    ]);
    const events = await collect(baseDeps({ llm }));
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    const tokens = events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("");
    expect(tokens).toBe("Patrick Collison is the CEO. Let me know if you want recent news.");
  });
});

describe("runAgentTurn — web tools", () => {
  it("runs web_search (free) and feeds results back, then answers with a citation", async () => {
    const web = makeMockWebClient({
      async search() {
        return [{ title: "Stripe", url: "https://stripe.com/about", snippet: "Stripe is a payments company." }];
      },
    });
    const llm = makeTurnScriptedLLM([
      [{ type: "tool_call_request", id: "w1", name: "web_search", args: { query: "who is the CEO of Stripe" } }, { type: "done", stopReason: "tool_use" }],
      [{ type: "token", text: "Patrick Collison. (stripe.com/about)" }, { type: "done", stopReason: "end" }],
    ]);
    const events = await collect(baseDeps({ llm, web }));
    const types = events.map((e) => e.type);

    // Web search shows in the trace as a free step (no budget, no permission).
    expect(types).toContain("tool_call_started");
    const started = events.find((e) => e.type === "tool_call_started");
    expect(started).toMatchObject({ api: "web", estCents: 0 });
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ priceCents: 0, ok: true });
    expect(events.some((e) => e.type === "permission_required")).toBe(false);

    const answer = events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("");
    expect(answer).toContain("Patrick Collison");
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end" });
  });

  it("recovers from a web_scrape failure instead of aborting the turn", async () => {
    const web = makeMockWebClient({
      async scrape() {
        throw new Error("could not read https://x.com (403)");
      },
    });
    const llm = makeTurnScriptedLLM([
      [{ type: "tool_call_request", id: "w1", name: "web_scrape", args: { url: "https://x.com" } }, { type: "done", stopReason: "tool_use" }],
      [{ type: "token", text: "I couldn't open that page." }, { type: "done", stopReason: "end" }],
    ]);
    const events = await collect(baseDeps({ llm, web }));
    const failed = events.find((e) => e.type === "tool_result" && (e as { ok: boolean }).ok === false);
    expect(failed).toBeTruthy();
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end" });
  });

  it("reads multiple URLs in parallel via scrapeMany and feeds every page back", async () => {
    const seen: string[][] = [];
    const web = makeMockWebClient({
      async scrapeMany(urls) {
        seen.push([...urls]);
        return urls.map((url, i) =>
          i === 1
            ? ({ status: "rejected", reason: new Error("blocked") } as PromiseRejectedResult)
            : ({ status: "fulfilled", value: { url, title: `Page ${i}`, markdown: `body ${i}`, truncated: false } } as PromiseFulfilledResult<WebPage>),
        );
      },
    });
    const llm = makeTurnScriptedLLM([
      [{ type: "tool_call_request", id: "w1", name: "web_scrape", args: { urls: ["https://a.com", "https://b.com", "https://c.com"] } }, { type: "done", stopReason: "tool_use" }],
      [{ type: "token", text: "Summarized three sources." }, { type: "done", stopReason: "end" }],
    ]);
    const events = await collect(baseDeps({ llm, web }));

    // One batched call, scraped concurrently (not three serial scrape() calls).
    expect(seen).toEqual([["https://a.com", "https://b.com", "https://c.com"]]);
    const started = events.find((e) => e.type === "tool_call_started");
    expect(started).toMatchObject({ api: "web", estCents: 0 });
    // 2 of 3 fulfilled → still ok, partial failure doesn't sink the batch.
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ ok: true, priceCents: 0 });
    expect((result as { summary: string }).summary).toContain("2/3");
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end" });
  });
});

describe("runAgentTurn — webSearch flag gates the web tools", () => {
  // An LLM that records the StreamInput it was handed each turn, so we can assert
  // exactly which tools were advertised to the model.
  function makeCapturingLLM(): { llm: LLMProvider; inputs: StreamInput[] } {
    const inputs: StreamInput[] = [];
    const llm: LLMProvider = {
      id: "anthropic",
      async *streamCompletion(input: StreamInput): AsyncIterable<LLMEvent> {
        inputs.push(input);
        yield { type: "token", text: "ok" };
        yield { type: "done", stopReason: "end" };
      },
    };
    return { llm, inputs };
  }

  it("omits web_search/web_scrape from the advertised tools when webSearch is false", async () => {
    const { llm, inputs } = makeCapturingLLM();
    await collect(baseDeps({ llm, webSearch: false }));
    const names = inputs[0]!.tools.map((t) => t.name);
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("web_scrape");
    // The catalog meta-tools still stay.
    expect(names).toContain("search_tools");
    expect(names).toContain("get_tool_details");
    expect(names).toContain("run_tool");
    expect(names).toContain("expand_result");
  });

  it("advertises web_search/web_scrape when the flag is unset (defaults ON)", async () => {
    const { llm, inputs } = makeCapturingLLM();
    await collect(baseDeps({ llm }));
    const names = inputs[0]!.tools.map((t) => t.name);
    expect(names).toContain("web_search");
    expect(names).toContain("web_scrape");
  });

  it("advertises the web tools when webSearch is explicitly true", async () => {
    const { llm, inputs } = makeCapturingLLM();
    await collect(baseDeps({ llm, webSearch: true }));
    const names = inputs[0]!.tools.map((t) => t.name);
    expect(names).toContain("web_search");
    expect(names).toContain("web_scrape");
  });
});

describe("runAgentTurn — iteration cap", () => {
  it("stops with max_tokens when the model never stops requesting tools", async () => {
    // Every turn requests a tool, so the loop must hit its iteration cap.
    const looping: LLMProvider = {
      id: "anthropic",
      async *streamCompletion(): AsyncIterable<LLMEvent> {
        yield RUN_CALL;
        yield { type: "done", stopReason: "tool_use" };
      },
    };
    const events = await collect(baseDeps({ llm: looping, maxIterations: 3 }));
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "max_tokens" });
    // 3 iterations × one run each → 3 tool_call_started.
    expect(events.filter((e) => e.type === "tool_call_started")).toHaveLength(3);
  });
});

// Capture the tool-role content fed back to the model (toolContent) via onMessage,
// since the loop never yields it as a TraceEvent.
function captureToolContent() {
  const contents: string[] = [];
  const onMessage = async (m: LLMMessage) => {
    if (m.role === "tool") contents.push(m.content);
  };
  return { contents, onMessage };
}

describe("runAgentTurn — deterministic catalog ranking", () => {
  it("ranks verified desc, score desc, price asc and tags the top match (recommended)", async () => {
    const orthogonal = makeMockOrthogonalClient({
      async search() {
        return [
          {
            name: "Cheap Unverified",
            slug: "cheap",
            endpoints: [{ id: "e0", path: "/p", method: "GET", description: "cheap but unverified", price: "0.01", verified: false, score: 0.99 }],
          },
          {
            name: "Verified Mid",
            slug: "midv",
            endpoints: [{ id: "e1", path: "/p", method: "GET", description: "verified mid score", price: "0.05", verified: true, score: 0.50 }],
          },
          {
            name: "Verified Top",
            slug: "topv",
            endpoints: [{ id: "e2", path: "/p", method: "GET", description: "verified top score", price: "0.09", verified: true, score: 0.90 }],
          },
        ];
      },
    });
    const { contents, onMessage } = captureToolContent();
    const llm = makeTurnScriptedLLM([
      [{ type: "tool_call_request", id: "s1", name: "search_tools", args: { query: "x" } }, { type: "done", stopReason: "tool_use" }],
      [{ type: "token", text: "ok" }, { type: "done", stopReason: "end" }],
    ]);
    await collect(baseDeps({ llm, orthogonal, onMessage }));

    const summary = contents.find((c) => c.includes("Found"));
    expect(summary).toBeTruthy();
    const lines = (summary as string).split("\n").slice(1); // drop the "Found N API(s)" header
    // Verified beats unverified regardless of its higher score; among verified, higher score wins.
    expect(lines[0]).toContain("topv");
    expect(lines[0]).toContain("(recommended)");
    expect(lines[1]).toContain("midv");
    expect(lines[2]).toContain("cheap");
    // Only the top entry is tagged.
    expect(lines.filter((l) => l.includes("(recommended)"))).toHaveLength(1);
  });

  it("breaks a verified+score tie by cheaper price", async () => {
    const orthogonal = makeMockOrthogonalClient({
      async search() {
        return [
          { name: "Pricey", slug: "pricey", endpoints: [{ id: "a", path: "/p", method: "GET", description: "d", price: "0.20", verified: true, score: 0.8 }] },
          { name: "Cheap", slug: "cheapv", endpoints: [{ id: "b", path: "/p", method: "GET", description: "d", price: "0.02", verified: true, score: 0.8 }] },
        ];
      },
    });
    const { contents, onMessage } = captureToolContent();
    const llm = makeTurnScriptedLLM([
      [{ type: "tool_call_request", id: "s1", name: "search_tools", args: { query: "x" } }, { type: "done", stopReason: "tool_use" }],
      [{ type: "token", text: "ok" }, { type: "done", stopReason: "end" }],
    ]);
    await collect(baseDeps({ llm, orthogonal, onMessage }));
    const summary = contents.find((c) => c.includes("Found")) as string;
    const firstLine = summary.split("\n")[1];
    expect(firstLine).toContain("cheapv");
    expect(firstLine).toContain("(recommended)");
  });
});

describe("runAgentTurn — web_search budget + dedup", () => {
  it("short-circuits a repeated (case/whitespace-normalized) query without re-hitting the web", async () => {
    let calls = 0;
    const web = makeMockWebClient({
      async search() {
        calls += 1;
        return [{ title: "T", url: "https://e.com", snippet: "s" }];
      },
    });
    const { contents, onMessage } = captureToolContent();
    const llm = makeTurnScriptedLLM([
      [{ type: "tool_call_request", id: "w1", name: "web_search", args: { query: "Who is the CEO" } }, { type: "done", stopReason: "tool_use" }],
      [{ type: "tool_call_request", id: "w2", name: "web_search", args: { query: "  who is the   CEO " } }, { type: "done", stopReason: "tool_use" }],
      [{ type: "token", text: "done" }, { type: "done", stopReason: "end" }],
    ]);
    await collect(baseDeps({ llm, web, onMessage }));
    expect(calls).toBe(1); // the duplicate never reached the web client
    expect(contents.some((c) => c.includes("Already searched that"))).toBe(true);
  });

  it("caps web_search per turn and feeds back the budget message", async () => {
    let calls = 0;
    const web = makeMockWebClient({
      async search(q) {
        calls += 1;
        return [{ title: q, url: `https://e.com/${calls}`, snippet: "s" }];
      },
    });
    // Six DISTINCT searches; default cap is 4 → 5th and 6th are refused.
    const searchTurns = Array.from({ length: 6 }, (_, i) => [
      { type: "tool_call_request", id: `w${i}`, name: "web_search", args: { query: `distinct query ${i}` } } as LLMEvent,
      { type: "done", stopReason: "tool_use" } as LLMEvent,
    ]);
    const { contents, onMessage } = captureToolContent();
    const llm = makeTurnScriptedLLM([...searchTurns, [{ type: "token", text: "done" }, { type: "done", stopReason: "end" }]]);
    await collect(baseDeps({ llm, web, onMessage, maxIterations: 10 }));
    expect(calls).toBe(4); // budget cap held
    expect(contents.some((c) => c.includes("Search budget reached"))).toBe(true);
  });

  it("raises the cap in deep-research mode", async () => {
    let calls = 0;
    const web = makeMockWebClient({
      async search(q) {
        calls += 1;
        return [{ title: q, url: `https://e.com/${calls}`, snippet: "s" }];
      },
    });
    const searchTurns = Array.from({ length: 6 }, (_, i) => [
      { type: "tool_call_request", id: `w${i}`, name: "web_search", args: { query: `distinct query ${i}` } } as LLMEvent,
      { type: "done", stopReason: "tool_use" } as LLMEvent,
    ]);
    const llm = makeTurnScriptedLLM([...searchTurns, [{ type: "token", text: "done" }, { type: "done", stopReason: "end" }]]);
    await collect(baseDeps({ llm, web, deepResearch: true, maxIterations: 10 }));
    expect(calls).toBe(6); // all six fit under the deep-research cap (8)
  });
});

describe("runAgentTurn — run_tool input echo", () => {
  it("echoes the inputs sent in the tool feedback so the model can self-check", async () => {
    const { contents, onMessage } = captureToolContent();
    const llm = makeTurnScriptedLLM([
      [RUN_CALL, { type: "done", stopReason: "tool_use" }],
      [{ type: "token", text: "done" }, { type: "done", stopReason: "end" }],
    ]);
    await collect(baseDeps({ llm, onMessage }));
    const feedback = contents.find((c) => c.startsWith("run_tool apollo"));
    expect(feedback).toBeTruthy();
    // The body the model sent is echoed back alongside the distilled summary + requestId.
    expect(feedback as string).toContain("stripe.com");
    expect(feedback as string).toContain("requestId:");
  });
});

describe("runAgentTurn — blank-turn guard", () => {
  it("does one synthesis retry when a turn ends with no answer tokens", async () => {
    const onMessage = vi.fn(async () => undefined);
    const llm = makeTurnScriptedLLM([
      // turn 1: model ends with NO tokens and no tool call (cold-start race).
      [{ type: "done", stopReason: "end" }],
      // synthesis retry: now it answers.
      [{ type: "token", text: "Here is the answer." }, { type: "done", stopReason: "end" }],
    ]);
    const events = await collect(baseDeps({ llm, onMessage }));
    const tokens = events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("");
    expect(tokens).toBe("Here is the answer.");
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end" });
    // The synthesis nudge itself is never persisted to the transcript.
    const persistedNudge = onMessage.mock.calls.some(
      ([m]) => (m as LLMMessage).role === "user" && (m as LLMMessage).content.includes("Answer now using what you already have"),
    );
    expect(persistedNudge).toBe(false);
  });

  it("streams an honest fallback line if the synthesis retry is also empty", async () => {
    const llm = makeTurnScriptedLLM([
      [{ type: "done", stopReason: "end" }], // blank turn
      [{ type: "done", stopReason: "end" }], // blank retry too
    ]);
    const events = await collect(baseDeps({ llm }));
    const tokens = events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("");
    expect(tokens.length).toBeGreaterThan(0); // never an empty bubble
    expect(tokens.toLowerCase()).toContain("rephrase");
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end" });
  });

  it("does not retry when the turn already produced an answer", async () => {
    let turns = 0;
    const llm: LLMProvider = {
      id: "anthropic",
      async *streamCompletion(): AsyncIterable<LLMEvent> {
        turns += 1;
        yield { type: "token", text: "Answered." };
        yield { type: "done", stopReason: "end" };
      },
    };
    await collect(baseDeps({ llm }));
    expect(turns).toBe(1); // a single, non-blank turn — no synthesis retry
  });
});
