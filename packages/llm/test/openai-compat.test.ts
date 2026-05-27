import { type LLMEvent, type LLMMessage } from "@ortha/contracts";
import { describe, expect, it } from "vitest";
import { createOpenAICompatProvider } from "../src/openai-compat.js";
import type { Transport, TransportRequest } from "../src/transport.js";

function cannedTransport(chunks: readonly unknown[], onReq?: (r: TransportRequest) => void): Transport {
  return async function* (req: TransportRequest) {
    onReq?.(req);
    for (const c of chunks) yield typeof c === "string" ? c : JSON.stringify(c);
  };
}
async function drain(it: AsyncIterable<LLMEvent>): Promise<void> {
  for await (const _ of it) void _;
}
const DONE = [{ choices: [{ delta: {}, finish_reason: "stop" }] }];

// Regression for the live-mode blocker: an assistant turn that requested tools must
// be replayed WITH its tool_calls, and the tool result must carry the function name,
// or providers (Gemini's compat layer especially) reject the orphaned function_response.
describe("openai-compat — tool round-trip serialization", () => {
  it("re-emits assistant tool_calls and the tool result name", async () => {
    let body: { messages: Array<Record<string, unknown>> } | undefined;
    const messages: LLMMessage[] = [
      { role: "user", content: "scrape example.com" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "run_tool", args: { api: "ctx", path: "/x" } }] },
      { role: "tool", toolCallId: "call_1", toolName: "run_tool", content: "the result" },
    ];
    const provider = createOpenAICompatProvider({
      providerId: "gemini",
      apiKey: "k",
      transport: cannedTransport(DONE, (r) => { body = JSON.parse(r.body) as typeof body; }),
    });
    await drain(provider.streamCompletion({ model: "gemini-2.5-flash", system: "sys", messages, tools: [], maxTokens: 256 }));

    const msgs = body!.messages;
    const asst = msgs.find((m) => m.role === "assistant") as { tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
    expect(asst.tool_calls).toHaveLength(1);
    expect(asst.tool_calls[0]!.id).toBe("call_1");
    expect(asst.tool_calls[0]!.type).toBe("function");
    expect(asst.tool_calls[0]!.function.name).toBe("run_tool");
    expect(JSON.parse(asst.tool_calls[0]!.function.arguments)).toEqual({ api: "ctx", path: "/x" });

    const tool = msgs.find((m) => m.role === "tool") as { name: string; tool_call_id: string };
    expect(tool.name).toBe("run_tool");
    expect(tool.tool_call_id).toBe("call_1");
  });

  it("emits an image_url content part for a user message with images (vision)", async () => {
    let body: { messages: Array<Record<string, unknown>> } | undefined;
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const messages: LLMMessage[] = [
      { role: "user", content: "what is in this image?", images: [dataUrl, "https://example.com/cat.jpg"] },
    ];
    const provider = createOpenAICompatProvider({
      providerId: "gemini",
      apiKey: "k",
      transport: cannedTransport(DONE, (r) => { body = JSON.parse(r.body) as typeof body; }),
    });
    await drain(provider.streamCompletion({ model: "gemini-2.5-flash", system: "", messages, tools: [], maxTokens: 256 }));

    const user = body!.messages.find((m) => m.role === "user") as { content: Array<Record<string, unknown>> };
    expect(Array.isArray(user.content)).toBe(true);
    expect(user.content[0]).toEqual({ type: "text", text: "what is in this image?" });
    expect(user.content[1]).toEqual({ type: "image_url", image_url: { url: dataUrl } });
    expect(user.content[2]).toEqual({ type: "image_url", image_url: { url: "https://example.com/cat.jpg" } });
  });

  it("keeps user content a plain string when no images are attached (backward compatible)", async () => {
    let body: { messages: Array<Record<string, unknown>> } | undefined;
    const messages: LLMMessage[] = [{ role: "user", content: "hello" }];
    const provider = createOpenAICompatProvider({
      providerId: "gemini",
      apiKey: "k",
      transport: cannedTransport(DONE, (r) => { body = JSON.parse(r.body) as typeof body; }),
    });
    await drain(provider.streamCompletion({ model: "gemini-2.5-flash", system: "", messages, tools: [], maxTokens: 256 }));
    const user = body!.messages.find((m) => m.role === "user") as { content: unknown };
    expect(user.content).toBe("hello");
  });

  it("recovers the first object when Gemini concatenates two tool-call argument fragments", async () => {
    // Gemini's compat layer sometimes merges two parallel calls' args into one
    // fragment. The parser must recover the first call rather than abort the turn.
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: '{"query":"a"}{"query":"b"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const provider = createOpenAICompatProvider({ providerId: "gemini", apiKey: "k", transport: cannedTransport(chunks) });
    const events: LLMEvent[] = [];
    for await (const e of provider.streamCompletion({ model: "gemini-2.5-flash", system: "", messages: [], tools: [], maxTokens: 256 })) events.push(e);

    const call = events.find((e) => e.type === "tool_call_request") as Extract<LLMEvent, { type: "tool_call_request" }>;
    expect(call).toBeTruthy();
    expect(call.name).toBe("web_search");
    expect(call.args).toEqual({ query: "a" });
    // The turn completed normally — no throw.
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("captures Gemini 3's extra_content (thought_signature) on a streamed tool call", async () => {
    const extra = { google: { thought_signature: "EuICabc123" } };
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", extra_content: extra, function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const provider = createOpenAICompatProvider({ providerId: "gemini", apiKey: "k", transport: cannedTransport(chunks) });
    const events: LLMEvent[] = [];
    for await (const e of provider.streamCompletion({ model: "gemini-3-flash-preview", system: "", messages: [], tools: [], maxTokens: 256 })) events.push(e);

    const call = events.find((e) => e.type === "tool_call_request") as Extract<LLMEvent, { type: "tool_call_request" }>;
    expect(call.extra).toEqual(extra);
  });

  it("echoes a tool call's extra (thought_signature) back as extra_content when replaying history", async () => {
    let body: { messages: Array<Record<string, unknown>> } | undefined;
    const extra = { google: { thought_signature: "EuICabc123" } };
    const messages: LLMMessage[] = [
      { role: "user", content: "weather?" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "get_weather", args: { city: "Paris" }, extra }] },
      { role: "tool", toolCallId: "c1", toolName: "get_weather", content: "sunny" },
    ];
    const provider = createOpenAICompatProvider({
      providerId: "gemini",
      apiKey: "k",
      transport: cannedTransport(DONE, (r) => { body = JSON.parse(r.body) as typeof body; }),
    });
    await drain(provider.streamCompletion({ model: "gemini-3-flash-preview", system: "", messages, tools: [], maxTokens: 256 }));

    const asst = body!.messages.find((m) => m.role === "assistant") as { tool_calls: Array<Record<string, unknown>> };
    expect(asst.tool_calls[0]!.extra_content).toEqual(extra);
  });
});
