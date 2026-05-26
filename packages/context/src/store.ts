import type { ConversationId, MemoryHit, MemoryStore, RequestId } from "@ortha/contracts";
import { rankByOverlap } from "./retrieval.js";

/**
 * A minimal async key-value port. Map-backed in tests; a Cloudflare KV / D1 adapter
 * in prod. Values are stored as-is; the store decides what to put where.
 */
export interface KvPort<V> {
  get(key: string): Promise<V | null>;
  put(key: string, value: V): Promise<void>;
}

/** A Map-backed KvPort for tests and local dev. */
export function mapKvPort<V>(backing: Map<string, V> = new Map()): KvPort<V> {
  return {
    async get(key) {
      return backing.has(key) ? (backing.get(key) as V) : null;
    },
    async put(key, value) {
      backing.set(key, value);
    },
  };
}

export interface CreateMemoryStoreDeps {
  /** Out-of-context raw tool results, keyed by requestId. */
  readonly rawStore: KvPort<unknown>;
  /**
   * In-context summary state, keyed by conversationId. Holds the appended summary
   * list plus the folded rolling summary.
   */
  readonly summaryStore: KvPort<ConvSummaryState>;
  /** Injectable summarizer — deterministic in tests, model-assisted in prod. */
  summarize(text: string): Promise<string>;
  /** Items beyond this count get folded into the rolling summary. Default 10. */
  readonly rollingThreshold?: number;
}

/** Persisted per-conversation summary state. */
export interface ConvSummaryState {
  /** Compact per-turn summaries appended via appendDistilled, oldest-first. */
  readonly summaries: readonly string[];
  /** Folded summary of turns that have aged out of `summaries`, or null. */
  readonly rolling: string | null;
}

const EMPTY_STATE: ConvSummaryState = { summaries: [], rolling: null };
const DEFAULT_THRESHOLD = 10;

export function createMemoryStore(deps: CreateMemoryStoreDeps): MemoryStore {
  const threshold = deps.rollingThreshold ?? DEFAULT_THRESHOLD;

  async function loadState(conversationId: ConversationId): Promise<ConvSummaryState> {
    return (await deps.summaryStore.get(conversationId)) ?? EMPTY_STATE;
  }

  return {
    async appendDistilled(conversationId, requestId, summary, raw): Promise<void> {
      // 1) Stash the full raw result out-of-context, keyed by requestId.
      await deps.rawStore.put(requestId, raw);
      // 2) Append the compact summary to the conversation's in-context list.
      const state = await loadState(conversationId);
      const next: ConvSummaryState = {
        summaries: [...state.summaries, summary],
        rolling: state.rolling,
      };
      await deps.summaryStore.put(conversationId, next);
    },

    async getRaw(requestId: RequestId): Promise<unknown | null> {
      return deps.rawStore.get(requestId);
    },

    async retrieve(conversationId: ConversationId, query: string, k: number): Promise<readonly MemoryHit[]> {
      const state = await loadState(conversationId);
      return rankByOverlap(state.summaries, query, k);
    },

    async rollingSummary(conversationId: ConversationId): Promise<string | null> {
      const state = await loadState(conversationId);
      // Short conversation: nothing to fold yet.
      if (state.summaries.length <= threshold) {
        return state.rolling;
      }

      // Fold the OLDEST overflow items (everything beyond the most-recent
      // `threshold`) into a single rolling summary, preserving any prior rolling.
      const keepFrom = state.summaries.length - threshold;
      const overflow = state.summaries.slice(0, keepFrom);
      const recent = state.summaries.slice(keepFrom);

      const toFold = [state.rolling, ...overflow].filter((s): s is string => !!s && s.length > 0).join("\n");
      const rolling = await deps.summarize(toFold);

      const next: ConvSummaryState = { summaries: recent, rolling };
      await deps.summaryStore.put(conversationId, next);
      return rolling;
    },
  };
}
