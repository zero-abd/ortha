// Anthropic-native adapter. Maps the Messages streaming API (SSE) to LLMEvent.
//
// Native stream shape (each SSE `data:` line is one JSON object with a `type`):
//   message_start          -> message.usage.input_tokens
//   content_block_start     -> for tool_use blocks: { id, name }
//   content_block_delta     -> text_delta.text  | input_json_delta.partial_json
//   content_block_stop      -> a tool block is complete; emit tool_call_request
//   message_delta           -> delta.stop_reason + usage.output_tokens
//   message_stop            -> end of stream
//
// QUIRKS:
//  - Tool-call arguments arrive as a *stream of JSON fragments* (partial_json)
//    that must be concatenated, then JSON.parsed once on content_block_stop.
//  - Usage is split: input tokens land on message_start, output tokens on the
//    final message_delta. We coalesce both into one {usage} event at the end.
//  - System prompt is a top-level `system` field, NOT a message.
//  - "tool" role messages map to a user message carrying a tool_result block.
import {
  ErrorCode,
  OrthaError,
  type LLMEvent,
  type LLMMessage,
  type LLMProvider,
  type StreamInput,
  type ToolSpec,
} from "@ortha/contracts";
import { abortError, fetchSseTransport, type Transport } from "./transport.js";

export interface AnthropicProviderConfig {
  readonly apiKey: string;
  /** Override for testing / proxies. Defaults to the public API. */
  readonly baseUrl?: string;
  readonly anthropicVersion?: string;
  /** Injectable network seam. Defaults to a real fetch+SSE transport. */
  readonly transport?: Transport;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = "https://api.anthropic.com";
const DEFAULT_VERSION = "2023-06-01";

export function createAnthropicProvider(config: AnthropicProviderConfig): LLMProvider {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  const version = config.anthropicVersion ?? DEFAULT_VERSION;
  const transport = config.transport ?? fetchSseTransport(config.fetchImpl ?? globalThis.fetch);

  return {
    id: "anthropic",
    streamCompletion(input: StreamInput): AsyncIterable<LLMEvent> {
      return run(input);
    },
  };

  async function* run(input: StreamInput): AsyncIterable<LLMEvent> {
    if (input.signal?.aborted) throw abortError();

    const body: Record<string, unknown> = {
      model: input.model,
      max_tokens: input.maxTokens,
      stream: true,
      messages: toAnthropicMessages(input.messages),
    };
    if (input.system) body["system"] = input.system;
    if (input.tools.length > 0) body["tools"] = input.tools.map(toAnthropicTool);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": version,
      "x-api-key": config.apiKey,
    };

    const reqBase = {
      url: `${baseUrl}/v1/messages`,
      method: "POST" as const,
      headers,
      body: JSON.stringify(body),
    };
    const req = input.signal ? { ...reqBase, signal: input.signal } : reqBase;

    // Coalesced state.
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: "end" | "tool_use" | "max_tokens" | "error" = "end";
    let emittedUsage = false;
    let emittedDone = false;

    // Per-content-block accumulation (index -> partial tool call).
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

    for await (const chunk of transport(req)) {
      if (input.signal?.aborted) throw abortError();
      const evt = parseJson(chunk);
      const type = evt["type"];

      if (type === "message_start") {
        const usage = asRecord(asRecord(evt["message"])["usage"]);
        inputTokens = numberOr(usage["input_tokens"], inputTokens);
      } else if (type === "content_block_start") {
        const index = numberOr(evt["index"], -1);
        const block = asRecord(evt["content_block"]);
        if (block["type"] === "tool_use") {
          toolBlocks.set(index, {
            id: stringOr(block["id"], ""),
            name: stringOr(block["name"], ""),
            json: "",
          });
        }
      } else if (type === "content_block_delta") {
        const index = numberOr(evt["index"], -1);
        const delta = asRecord(evt["delta"]);
        if (delta["type"] === "text_delta") {
          const text = stringOr(delta["text"], "");
          if (text) yield { type: "token", text };
        } else if (delta["type"] === "input_json_delta") {
          const block = toolBlocks.get(index);
          if (block) block.json += stringOr(delta["partial_json"], "");
        }
      } else if (type === "content_block_stop") {
        const index = numberOr(evt["index"], -1);
        const block = toolBlocks.get(index);
        if (block) {
          toolBlocks.delete(index);
          yield {
            type: "tool_call_request",
            id: block.id,
            name: block.name,
            args: parseArgs(block.json),
          };
        }
      } else if (type === "message_delta") {
        const delta = asRecord(evt["delta"]);
        stopReason = mapStopReason(delta["stop_reason"]);
        const usage = asRecord(evt["usage"]);
        outputTokens = numberOr(usage["output_tokens"], outputTokens);
      } else if (type === "message_stop") {
        yield { type: "usage", inputTokens, outputTokens };
        emittedUsage = true;
        yield { type: "done", stopReason };
        emittedDone = true;
      } else if (type === "error") {
        const err = asRecord(evt["error"]);
        throw new OrthaError(ErrorCode.PROVIDER_DOWN, `anthropic stream error: ${stringOr(err["message"], "unknown")}`, {
          retryable: true,
        });
      }
    }

    // Defensive: if the stream ended without an explicit message_stop, still
    // emit terminal events so consumers never hang waiting for {done}.
    if (!emittedUsage) yield { type: "usage", inputTokens, outputTokens };
    if (!emittedDone) yield { type: "done", stopReason };
  }
}

function toAnthropicMessages(messages: readonly LLMMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // system goes to the top-level field
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content }],
      });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      // Re-emit tool_use blocks; a following tool_result must reference a tool_use
      // in the preceding assistant turn or Anthropic rejects the request.
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

function toAnthropicTool(t: ToolSpec): Record<string, unknown> {
  return { name: t.name, description: t.description, input_schema: t.inputSchema };
}

function mapStopReason(v: unknown): "end" | "tool_use" | "max_tokens" | "error" {
  switch (v) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "end_turn":
    case "stop_sequence":
      return "end";
    default:
      return "end";
  }
}

function parseArgs(json: string): Record<string, unknown> {
  const trimmed = json.trim();
  if (trimmed === "") return {};
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJson(chunk: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(chunk);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const asRecord = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
const numberOr = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);
const stringOr = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
