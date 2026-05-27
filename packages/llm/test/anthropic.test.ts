import { isOrthaError, type LLMEvent, type StreamInput, type ToolSpec } from "@ortha/contracts";
import { describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../src/anthropic.js";
import type { Transport, TransportRequest } from "../src/transport.js";

/** A transport that replays a fixed list of raw JSON chunks (one per SSE data line). */
function cannedTransport(chunks: readonly unknown[], onReq?: (r: TransportRequest) => void): Transport {
  return async function* (req: TransportRequest) {
    onReq?.(req);
    for (const c of chunks) yield typeof c === "string" ? c : JSON.stringify(c);
  };
}

async function collect(it: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
  const out: LLMEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const TOOLS: ToolSpec[] = [
  { name: "search_tools", description: "find tools", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
];

function input(over: Partial<StreamInput> = {}): StreamInput {
  return {
    model: "claude-3-5-sonnet-latest",
    system: "you are helpful",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    maxTokens: 256,
    ...over,
  };
}

describe("anthropic adapter — text stream", () => {
  it("maps text deltas to tokens, then usage, then done", async () => {
    const chunks = [
      { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];
    const provider = createAnthropicProvider({ apiKey: "sk-test", transport: cannedTransport(chunks) });
    const events = await collect(provider.streamCompletion(input()));

    expect(provider.id).toBe("anthropic");
    expect(events).toEqual([
      { type: "token", text: "Hello" },
      { type: "token", text: " world" },
      { type: "usage", inputTokens: 12, outputTokens: 5 },
      { type: "done", stopReason: "end" },
    ]);
  });
});

describe("anthropic adapter — tool calls", () => {
  it("accumulates partial_json fragments and emits a parsed tool_call_request", async () => {
    const chunks = [
      { type: "message_start", message: { usage: { input_tokens: 30 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "search_tools" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"crm"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ];
    const provider = createAnthropicProvider({ apiKey: "sk-test", transport: cannedTransport(chunks) });
    const events = await collect(provider.streamCompletion(input({ tools: TOOLS })));

    expect(events).toEqual([
      { type: "tool_call_request", id: "toolu_1", name: "search_tools", args: { q: "crm" } },
      { type: "usage", inputTokens: 30, outputTokens: 9 },
      { type: "done", stopReason: "tool_use" },
    ]);
  });

  it("interleaves a text block then a tool block", async () => {
    const chunks = [
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "let me look" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_2", name: "search_tools" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
      { type: "message_stop" },
    ];
    const provider = createAnthropicProvider({ apiKey: "sk-test", transport: cannedTransport(chunks) });
    const events = await collect(provider.streamCompletion(input({ tools: TOOLS })));
    expect(events[0]).toEqual({ type: "token", text: "let me look" });
    expect(events[1]).toEqual({ type: "tool_call_request", id: "toolu_2", name: "search_tools", args: {} });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });
  });
});

describe("anthropic adapter — request shaping & quirks", () => {
  it("puts system at the top level (not in messages) and maps tool-role messages to tool_result", async () => {
    let captured: TransportRequest | undefined;
    const provider = createAnthropicProvider({
      apiKey: "sk-test",
      transport: cannedTransport([{ type: "message_stop" }], (r) => (captured = r)),
    });
    await collect(
      provider.streamCompletion(
        input({
          system: "SYS",
          tools: TOOLS,
          messages: [
            { role: "user", content: "do it" },
            { role: "tool", content: "result-data", toolCallId: "toolu_1" },
          ],
        }),
      ),
    );
    const body = JSON.parse(captured!.body);
    expect(body.system).toBe("SYS");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "result-data" }],
    });
    // ToolSpec -> Anthropic schema uses input_schema.
    expect(body.tools[0]).toMatchObject({ name: "search_tools", input_schema: TOOLS[0]!.inputSchema });
    expect(captured!.headers["x-api-key"]).toBe("sk-test");
    expect(captured!.headers["anthropic-version"]).toBeTruthy();
  });

  it("emits image content blocks for a user message with images (vision)", async () => {
    let captured: TransportRequest | undefined;
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const provider = createAnthropicProvider({
      apiKey: "sk-test",
      transport: cannedTransport([{ type: "message_stop" }], (r) => (captured = r)),
    });
    await collect(
      provider.streamCompletion(
        input({
          messages: [{ role: "user", content: "describe these", images: [dataUrl, "https://example.com/cat.jpg"] }],
        }),
      ),
    );
    const body = JSON.parse(captured!.body);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "describe these" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      { type: "image", source: { type: "url", url: "https://example.com/cat.jpg" } },
    ]);
  });

  it("keeps user content a plain string when no images are attached (backward compatible)", async () => {
    let captured: TransportRequest | undefined;
    const provider = createAnthropicProvider({
      apiKey: "sk-test",
      transport: cannedTransport([{ type: "message_stop" }], (r) => (captured = r)),
    });
    await collect(provider.streamCompletion(input({ messages: [{ role: "user", content: "hi" }] })));
    const body = JSON.parse(captured!.body);
    expect(body.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  it("emits terminal usage+done even when the stream ends without message_stop", async () => {
    const chunks = [
      { type: "message_start", message: { usage: { input_tokens: 4 } } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 2 } },
    ];
    const provider = createAnthropicProvider({ apiKey: "sk-test", transport: cannedTransport(chunks) });
    const events = await collect(provider.streamCompletion(input()));
    expect(events).toEqual([
      { type: "token", text: "hi" },
      { type: "usage", inputTokens: 4, outputTokens: 2 },
      { type: "done", stopReason: "max_tokens" },
    ]);
  });

  it("throws on a mid-stream error event", async () => {
    const provider = createAnthropicProvider({
      apiKey: "sk-test",
      transport: cannedTransport([{ type: "error", error: { message: "overloaded" } }]),
    });
    const err = await collect(provider.streamCompletion(input())).catch((e) => e);
    expect(isOrthaError(err)).toBe(true);
  });
});

describe("anthropic adapter — abort", () => {
  it("rejects immediately when the signal is already aborted", async () => {
    const provider = createAnthropicProvider({ apiKey: "sk-test", transport: cannedTransport([]) });
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await collect(provider.streamCompletion(input({ signal: ctrl.signal }))).catch((e) => e);
    expect(isOrthaError(err) && err.code).toBe("TIMEOUT");
  });
});
