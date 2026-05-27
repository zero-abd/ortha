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
    // `extra` holds opaque provider metadata to echo back on replay — Gemini 3 sends
    // a per-call `extra_content: { google: { thought_signature } }` that a follow-up
    // request MUST include or the API rejects it (HTTP 400 "missing a thought_signature").
    const toolCalls = new Map<number, { id: string; name: string; args: string; extra?: unknown }>();

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
          // Gemini 3 attaches `extra_content` (the thought_signature) to the tool-call
          // delta; capture it verbatim so it can be replayed in history.
          if (raw["extra_content"] !== undefined) existing.extra = raw["extra_content"];
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
        ...(call.extra !== undefined ? { extra: call.extra } : {}),
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
      // `name` is required by Gemini's compat layer (function_response.name) and
      // ignored by OpenAI/OpenRouter, so always include it when known.
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        ...(m.toolName ? { name: m.toolName } : {}),
        content: m.content,
      });
    } else if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      // Re-emit the assistant's tool_calls so the following tool result has a parent.
      out.push({
        role: "assistant",
        content: m.content === "" ? null : m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          // Echo Gemini 3's thought_signature (captured as `extra` = the original
          // `extra_content`) back verbatim, or the API 400s on the follow-up request.
          ...(tc.extra !== undefined ? { extra_content: tc.extra } : {}),
        })),
      });
    } else if (m.role === "user" && m.images && m.images.length > 0) {
      // Vision: emit a content-parts array so the model sees the image(s).
      // Works for both OpenAI's and Gemini's OpenAI-compat endpoints.
      const parts: unknown[] = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const url of m.images) parts.push({ type: "image_url", image_url: { url } });
      out.push({ role: "user", content: parts });
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
  // Fast path: the whole fragment is one JSON object.
  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) return parsed;
  } catch {
    /* fall through to recovery */
  }
  // Gemini's compat layer sometimes concatenates two tool calls' argument objects
  // into one fragment ({"q":"a"}{"q":"b"}), which isn't valid JSON. Recover the
  // FIRST balanced object instead of throwing and aborting the whole turn — the
  // agent's intended call still runs, and a truly-garbage fragment yields {} (the
  // tool then reports "missing argument" and the loop continues).
  const first = firstJsonObject(trimmed);
  return first ?? {};
}

/** Extract the first balanced top-level JSON object from a string, or null. */
function firstJsonObject(s: string): Record<string, unknown> | null {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(s.slice(start, i + 1));
          return isRecord(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
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
