import type { Cents } from "./domain.js";

export type ProviderId = "anthropic" | "openai" | "openrouter" | "gemini";

/** A provider-neutral tool definition (e.g. the meta-tools search_tools/run_tool). */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool's arguments. */
  readonly inputSchema: Record<string, unknown>;
}

export interface LLMMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  /** Set when role === "tool": which tool_call_request this result answers. */
  readonly toolCallId?: string;
  /** Set when role === "tool": the tool's name. Required when replaying to providers
   *  (Gemini's OpenAI-compat layer rejects a function_response with an empty name). */
  readonly toolName?: string;
  /**
   * Set on an assistant message that requested tool calls. Carries the full call
   * (id + name + args) so the turn can be faithfully replayed to the provider — an
   * assistant turn that omits its tool_calls makes the following tool result an
   * orphan, which every provider rejects.
   */
  readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly args: Record<string, unknown> }[];
}

/** Normalized streaming event. Every adapter maps its native stream to this union. */
export type LLMEvent =
  | { readonly type: "token"; readonly text: string }
  | {
      readonly type: "tool_call_request";
      readonly id: string;
      readonly name: string;
      readonly args: Record<string, unknown>;
    }
  | {
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | { readonly type: "done"; readonly stopReason: "end" | "tool_use" | "max_tokens" | "error" };

export interface StreamInput {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly ToolSpec[];
  /** Hard ceiling on output tokens — also how LLM spend is pre-estimated for the cap. */
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
}

/**
 * The model seam. Two adapter shapes implement this: Anthropic-native and an
 * OpenAI-compatible adapter (OpenAI / OpenRouter / Gemini via base-URL swap).
 * INVARIANT: the app must run end-to-end with ANY single provider configured.
 */
export interface LLMProvider {
  readonly id: ProviderId;
  streamCompletion(input: StreamInput): AsyncIterable<LLMEvent>;
}

export interface ModelInfo {
  readonly id: string;
  readonly provider: ProviderId;
  readonly displayName: string;
  readonly inputPerMTokensCents: Cents;
  readonly outputPerMTokensCents: Cents;
  readonly supportsToolUse: boolean;
  /** True for models on a free tier — used to default dev/eval routing. */
  readonly free: boolean;
}

export interface ModelRegistry {
  list(): readonly ModelInfo[];
  get(id: string): ModelInfo | undefined;
  /** The default model id (a free, tool-capable model for dev). */
  defaultModelId(): string;
}
