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

/**
 * Default cap (in bytes of UTF-8 JSON) for a single raw value. Live tool results
 * measured at 173 KB–412 KB; anything over this is replaced by a truncated marker
 * so the durable store never holds or persists multi-hundred-KB blobs.
 */
export const DEFAULT_RAW_CAP_BYTES = 256 * 1024;

/** How many bytes of the original JSON to keep as a human-readable preview. */
const TRUNCATED_PREVIEW_BYTES = 2 * 1024;

/**
 * Marker persisted in place of an oversized value. `get` returns this object
 * verbatim (it is itself small), so a cross-turn `expand_result` sees that the
 * blob existed, how big it was, and a leading slice of it — instead of OOMing.
 */
export interface TruncatedBlob {
  readonly _truncated: true;
  /** Byte length of the original (un-truncated) serialized value. */
  readonly bytes: number;
  /** First ~2 KB of the original JSON string. */
  readonly preview: string;
}

/** Type guard for the truncated marker. */
export function isTruncatedBlob(value: unknown): value is TruncatedBlob {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _truncated?: unknown })._truncated === true
  );
}

/**
 * The minimal row backend a {@link createCappedKvStore} needs: store/fetch a JSON
 * string (plus its byte size) by key. Sync or async — a Map in tests, the
 * Conversation DO's SQLite in prod (see apps/edge/src/raw-store.ts). Decoupled from
 * any SQL type so @ortha/context stays dependency-free and unit-testable.
 */
export interface RawBlobBackend {
  getJson(key: string): Promise<string | null> | string | null;
  putJson(key: string, json: string, bytes: number): Promise<void> | void;
}

/** UTF-8 byte length of a string, without allocating a Buffer/TextEncoder per call when possible. */
const encoder = new TextEncoder();
function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/**
 * A durable, SIZE-CAPPED {@link KvPort}. `put` JSON-stringifies the value and, if
 * the serialized form exceeds `capBytes`, persists a small {@link TruncatedBlob}
 * marker instead of the full blob — bounding memory and storage. `get` parses the
 * stored JSON back (the marker round-trips as a plain object). Backed by any
 * {@link RawBlobBackend}, so the same capping logic fronts a Map (tests) or DO
 * SQLite (prod) without duplication.
 */
export function createCappedKvStore(
  backend: RawBlobBackend,
  capBytes: number = DEFAULT_RAW_CAP_BYTES,
): KvPort<unknown> {
  return {
    async put(key, value) {
      const json = JSON.stringify(value ?? null);
      const bytes = byteLength(json);
      if (bytes > capBytes) {
        const marker: TruncatedBlob = {
          _truncated: true,
          bytes,
          preview: json.slice(0, TRUNCATED_PREVIEW_BYTES),
        };
        const markerJson = JSON.stringify(marker);
        await backend.putJson(key, markerJson, byteLength(markerJson));
        return;
      }
      await backend.putJson(key, json, bytes);
    },
    async get(key) {
      const json = await backend.getJson(key);
      if (json == null) return null;
      return JSON.parse(json) as unknown;
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
