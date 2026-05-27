import { asConversationId, asMessageId, type Message } from "@ortha/contracts";
import { describe, expect, it } from "vitest";
import { reconstructHistory, type HistoryMessage } from "../src/history.js";

const CID = asConversationId("conv_1");
let seq = 0;

/**
 * Build a persisted Message exactly as the agent loop's onMessage writes it (and as
 * @ortha/db's loadWindow returns it), so the test exercises the real reconstruction
 * input without pulling in a native SQLite module the edge package doesn't depend on.
 */
function msg(role: Message["role"], content: string, extra: Partial<Message> = {}): Message {
  return {
    id: asMessageId(`m_${seq++}`),
    conversationId: CID,
    role,
    content,
    createdAt: Date.now() + seq,
    toolCallIds: [],
    ...extra,
  };
}

describe("reconstructHistory", () => {
  it("rebuilds a paid run_tool turn's trace step from the persisted transcript", () => {
    // A faithful slice of what the agent loop persists via onMessage for one turn:
    //   user → assistant tool-call turn (run_tool) → tool result → assistant answer.
    const window: Message[] = [
      msg("user", "send a text to 555"),
      msg("assistant", "", { toolCalls: [{ id: "call_1", name: "run_tool", args: { api: "textbelt", path: "/text" } }] }),
      msg("tool", "run_tool textbelt /text {body:{...}} → {success:true,textId:42} (requestId: req_abc)", {
        toolCallId: "call_1",
        toolName: "run_tool",
        // Persisted on the tool result (toolMeta) so price/latency restore on reload.
        priceCents: 2.5,
        latencyMs: 4840,
      }),
      msg("assistant", "Done — your text was sent."),
    ];

    const history = reconstructHistory(window);

    expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
    const answer = history[1]!;
    expect(answer.content).toBe("Done — your text was sent.");
    expect(answer.steps).toHaveLength(1);
    const step = answer.steps![0]!;
    expect(step.api).toBe("textbelt");
    expect(step.path).toBe("/text");
    expect(step.status).toBe("success");
    expect(step.requestId).toBe("req_abc");
    expect(step.summary).toBe("{success:true,textId:42}");
    // Price (a fractional cent) + latency round-trip onto the restored block.
    expect(step.priceCents).toBe(2.5);
    expect(step.latencyMs).toBe(4840);
    // The user turn carries no steps.
    expect(history[0]!.steps).toBeUndefined();
  });

  it("marks a failed run_tool step failed and omits its requestId", () => {
    const window: Message[] = [
      msg("user", "look up acme.com"),
      msg("assistant", "", { toolCalls: [{ id: "call_2", name: "run_tool", args: { api: "clearbit", path: "/company" } }] }),
      msg("tool", "clearbit /company failed (PROVIDER_DOWN: upstream 503). Do not retry the same call.", {
        toolCallId: "call_2",
        toolName: "run_tool",
      }),
      msg("assistant", "That lookup failed."),
    ];

    const step = reconstructHistory(window)[1]!.steps![0]!;
    expect(step.status).toBe("failed");
    expect(step.api).toBe("clearbit");
    expect(step.requestId).toBeUndefined();
  });

  it("reconstructs a web_search step and skips internal search_tools plumbing", () => {
    const window: Message[] = [
      msg("user", "latest news on X"),
      // search_tools is an internal meta-tool turn — it should NOT become a restored block.
      msg("assistant", "", { toolCalls: [{ id: "call_s", name: "search_tools", args: { query: "news api" } }] }),
      msg("tool", "matched 3 tools", { toolCallId: "call_s", toolName: "search_tools" }),
      // web_search IS a user-visible trace block.
      msg("assistant", "", { toolCalls: [{ id: "call_w", name: "web_search", args: { query: "X latest" } }] }),
      msg("tool", '5 web results for "X latest"', { toolCallId: "call_w", toolName: "web_search" }),
      msg("assistant", "Here's what I found."),
    ];

    const steps = reconstructHistory(window)[1]!.steps!;
    // Only the web_search block survives; search_tools is dropped.
    expect(steps).toHaveLength(1);
    expect(steps[0]!.api).toBe("web");
    expect(steps[0]!.path).toBe('search: "X latest"');
    expect(steps[0]!.status).toBe("success");
  });

  it("attaches multiple steps from one turn above that turn's single answer bubble", () => {
    const window: Message[] = [
      msg("user", "research and notify"),
      msg("assistant", "", { toolCalls: [{ id: "c1", name: "web_search", args: { query: "topic" } }] }),
      msg("tool", '3 web results for "topic"', { toolCallId: "c1", toolName: "web_search" }),
      msg("assistant", "", { toolCalls: [{ id: "c2", name: "run_tool", args: { api: "textbelt", path: "/text" } }] }),
      msg("tool", "run_tool textbelt /text {} → {sent:true} (requestId: req_z)", { toolCallId: "c2", toolName: "run_tool" }),
      msg("assistant", "Researched it and sent the text."),
    ];

    const answer = reconstructHistory(window)[1]!;
    expect(answer.steps).toHaveLength(2);
    expect(answer.steps!.map((s) => s.api)).toEqual(["web", "textbelt"]);
    expect(answer.steps![1]!.requestId).toBe("req_z");
  });

  it("returns plain user/assistant turns with no steps when no tools ran", () => {
    const history: HistoryMessage[] = reconstructHistory([msg("user", "hi"), msg("assistant", "hello!")]);
    expect(history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello!" },
    ]);
  });
});
