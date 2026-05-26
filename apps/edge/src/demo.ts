import type { BudgetPolicy, LLMEvent, LLMProvider, MemoryStore, OrthogonalClient } from "@ortha/contracts";
import { makeMockBudgetPolicy, makeMockMemoryStore, makeMockOrthogonalClient } from "@ortha/contracts/mocks";

/**
 * Demo ports: drive the REAL agent loop with mock implementations so the deployed
 * Worker streams a genuine agentic turn (discover tool → run tool → answer) over a
 * Durable Object WebSocket, with zero API keys and zero spend. Live mode swaps these
 * for the real harness/LLM/budget once BYOK keys are configured.
 */
export interface DemoPorts {
  llm: LLMProvider;
  orthogonal: OrthogonalClient;
  budget: BudgetPolicy;
  memory: MemoryStore;
}

export function createDemoPorts(): DemoPorts {
  return {
    llm: createDemoLLM(),
    orthogonal: makeMockOrthogonalClient(),
    budget: makeMockBudgetPolicy(),
    memory: makeMockMemoryStore(),
  };
}

/** A stateful scripted LLM: discovers a tool, runs it, then answers — one tool per turn. */
function createDemoLLM(): LLMProvider {
  let call = 0;
  return {
    id: "anthropic",
    async *streamCompletion(): AsyncIterable<LLMEvent> {
      call += 1;
      if (call === 1) {
        yield { type: "tool_call_request", id: "tc_search", name: "search_tools", args: { query: "enrich a person by email or company role" } };
        yield { type: "usage", inputTokens: 60, outputTokens: 12 };
        yield { type: "done", stopReason: "tool_use" };
      } else if (call === 2) {
        yield { type: "tool_call_request", id: "tc_run", name: "run_tool", args: { api: "apollo", path: "/v1/people/match", body: { email: "ceo@stripe.com" } } };
        yield { type: "usage", inputTokens: 140, outputTokens: 24 };
        yield { type: "done", stopReason: "tool_use" };
      } else {
        const answer =
          "Based on the live lookup, Stripe's CEO is Patrick Collison. This came from the real agent loop discovering and calling a tool, streamed over a Durable Object WebSocket.";
        for (const word of answer.split(" ")) yield { type: "token", text: word + " " };
        yield { type: "usage", inputTokens: 220, outputTokens: 34 };
        yield { type: "done", stopReason: "end" };
      }
    },
  };
}
