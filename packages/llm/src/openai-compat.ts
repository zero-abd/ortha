// One OpenAI-compatible adapter covering THREE providers via a {baseUrl, apiKey,
// model} swap: OpenAI, OpenRouter, and Google Gemini's OpenAI-compat endpoint.
// All three speak the Chat Completions streaming protocol.
//
//   POST {baseUrl}/chat/completions   (stream: true)
//   each SSE `data:` line -> { choices: [{ delta, finish_reason }], usage? }
//     delta.content                      -> token text
//     delta.tool_calls[].function.name   -> tool name (first fragment)
//     delta.tool_calls[].function.arguments -> JSON arg fragments (concatenate)
//     delta.tool_calls[].id              -> provider-native call id
//     finish_reason: "stop" | "length" | "tool_calls"
//   final chunk (with stream_options.include_usage) carries `usage`.
//
// PROVIDER QUIRKS (see `OpenAICompatQuirks`):
//  - Gemini's OpenAI-compat layer historically did NOT honor
//    `stream_options.include_usage`, so usage may be absent — we still emit a
//    {usage} event (zeros) so the event contract holds. It also tends to send
//    the entire tool-call `arguments` in a single fragment rather than streaming
//    them; concatenation handles both. Gemini ignores `parallel_tool_calls`.
//  - OpenRouter proxies many upstreams; some omit per-chunk `id` on tool calls.
//    We synthesize a stable id (`call_<index>`) when absent.
//  - OpenAI streams tool-call arguments as many small fragments — always
//    accumulate before parsing.
import {
  ErrorCode,
  OrthaError,
  type LLMEvent,
  type LLMMessage,
  type LLMProvider,
  type ProviderId,
  type StreamInput,
  type ToolSpec,
} from "@ortha/contracts";
import { abortError, fetchSseTransport, type Transport } from "./transport.js";

/** Documented behavioral differences between the OpenAI-compatible backends. */
export interface OpenAICompatQuirks {
  /** Send `stream_options: { include_usage: true }`. OpenAI/OpenRouter: true; Gemini: false (ignored). */
  readonly sendStreamUsageOption: boolean;
  /** Send `parallel_tool_calls`. Unsupported by Gemini's compat layer. */
  readonly sendParallelToolCalls: boolean;
}

export const OPENAI_QUIRKS: OpenAICompatQuirks = {
  sendStreamUsageOption: true,
  sendParallelToolCalls: true,
};

export const OPENROUTER_QUIRKS: OpenAICompatQuirks = {
  sendStreamUsageOption: true,
  sendParallelToolCalls: false,
};

export const GEMINI_QUIRKS: OpenAICompatQuirks = {
  sendStreamUsageOption: false,
  sendParallelToolCalls: false,
};

export interface OpenAICompatProviderConfig {
  /**
   * Which of the three this instance targets. Drives the `LLMProvider.id` and
   * the default quirks/baseUrl. The wire protocol is identical across all.
   */
  readonly providerId: Extract<ProviderId, "openai" | "openrouter" | "gemini">;
  readonly apiKey: string;
  /** Override the default per-provider base URL. */
  readonly baseUrl?: string;
  /** Override the default per-provider quirks. */
  readonly quirks?: OpenAICompatQuirks;
  /** Injectable network seam. Defaults to a real fetch+SSE transport. */
  readonly transport?: Transport;
  readonly fetchImpl?: typeof fetch;
  /** Extra headers (e.g. OpenRouter's HTTP-Referer / X-Title). */
  readonly extraHeaders?: Record<string, string>;
}

const DEFAULT_BASE: Record<OpenAICompatProviderConfig["providerId"], string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
};

const DEFAULT_QUIRKS: Record<OpenAICompatProviderConfig["providerId"], OpenAICompatQuirks> = {
  openai: OPENAI_QUIRKS,
  openrouter: OPENROUTER_QUIRKS,
  gemini: GEMINI_QUIRKS,
};

export function createOpenAICompatProvider(config: OpenAICompatProviderConfig): LLMProvider {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE[config.providerId]).replace(/\/$/, "");
  const quirks = config.quirks ?? DEFAULT_QUIRKS[config.providerId];
  const transport = config.transport ?? fetchSseTransport(config.fetchImpl ?? globalThis.fetch);

  return {
    id: config.providerId,
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
      messages: toOpenAIMessages(input.system, input.messages),
    };
    if (input.tools.length > 0) {
      body["tools"] = input.tools.map(toOpenAITool);
      if (quirks.sendParallelToolCalls) body["parallel_tool_calls"] = true;
    }
    if (quirks.sendStreamUsageOption) body["stream_options"] = { include_usage: true };

    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
      ...config.extraHeaders,
    };

    const reqBase = {
      url: `${baseUrl}/chat/completions`,
      method: "POST" as const,
      headers,
      body: JSON.stringify(body),
    };
    const req = input.signal ? { ...reqBase, signal: input.signal } : reqBase;

    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: "end" | "tool_use" | "max_tokens" | "error" = "end";
    let sawUsage = false;

    // index -> partial tool call. Tool calls stream in fragments keyed by index.
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of transport(req)) {
      if (input.signal?.aborted) throw abortError();
      const evt = parseJson(chunk);

      const usage = evt["usage"];
      if (isRecord(usage)) {
        inputTokens = numberOr(usage["prompt_tokens"], inputTokens);
        outputTokens = numberOr(usage["completion_tokens"], outputTokens);
        sawUsage = true;
      }

      const choices = evt["choices"];
      const choice = Array.isArray(choices) && isRecord(choices[0]) ? (choices[0] as Record<string, unknown>) : null;
      if (!choice) continue;

      const delta = asRecord(choice["delta"]);
      const content = delta["content"];
      if (typeof content === "string" && content) yield { type: "token", text: content };

      const deltaCalls = delta["tool_calls"];
      if (Array.isArray(deltaCalls)) {
        for (const raw of deltaCalls) {
          if (!isRecord(raw)) continue;
          const index = numberOr(raw["index"], 0);
          const existing = toolCalls.get(index) ?? { id: "", name: "", args: "" };
          const id = stringOr(raw["id"], "");
          if (id) existing.id = id;
          const fn = asRecord(raw["function"]);
          const name = stringOr(fn["name"], "");
          if (name) existing.name = name;
          existing.args += stringOr(fn["arguments"], "");
          toolCalls.set(index, existing);
        }
      }

      const finish = choice["finish_reason"];
      if (typeof finish === "string" && finish) {
        stopReason = mapFinishReason(finish);
      }
    }

    // Tool calls are flushed once the stream completes (args fully accumulated).
    for (const [index, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      yield {
        type: "tool_call_request",
        id: call.id || `call_${index}`,
        name: call.name,
        args: parseArgs(call.args),
      };
    }

    // Always emit a {usage} event. On the Gemini path `sawUsage` is false and
    // both counts are zero, but the event-contract still holds for consumers.
    void sawUsage;
    yield { type: "usage", inputTokens, outputTokens };
    yield { type: "done", stopReason };
  }
}

function toOpenAIMessages(system: string, messages: readonly LLMMessage[]): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: m.content });
    } else if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function toOpenAITool(t: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  };
}

function mapFinishReason(v: string): "end" | "tool_use" | "max_tokens" | "error" {
  switch (v) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "error";
    case "stop":
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
    throw new OrthaError(ErrorCode.BAD_REQUEST, `malformed tool-call arguments: ${trimmed.slice(0, 120)}`);
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
