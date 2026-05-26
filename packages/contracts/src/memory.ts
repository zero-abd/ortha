import type { ConversationId, RequestId } from "./ids.js";

export interface MemoryHit {
  readonly text: string;
  readonly score: number;
  readonly source: "message" | "tool_result";
}

/**
 * Owns the context-window strategy: stores raw tool results out-of-context (keyed
 * by requestId, surfaced on demand via `expand_result`), keeps a rolling summary of
 * old turns, and (when Vectorize is enabled) does semantic retrieval. v1 may back
 * `retrieve` with recency+summary only.
 */
export interface MemoryStore {
  /** Persist a tool result: full `raw` out-of-context, compact `summary` in-context. */
  appendDistilled(
    conversationId: ConversationId,
    requestId: RequestId,
    summary: string,
    raw: unknown,
  ): Promise<void>;

  /** Fetch the full raw result for the right-panel `expand_result` view. */
  getRaw(requestId: RequestId): Promise<unknown | null>;

  /** Retrieve the top-k relevant prior turns/results for the current query. */
  retrieve(conversationId: ConversationId, query: string, k: number): Promise<readonly MemoryHit[]>;

  /** Current rolling summary of older turns, or null if the convo is still short. */
  rollingSummary(conversationId: ConversationId): Promise<string | null>;
}
