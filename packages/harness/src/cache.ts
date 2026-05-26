// Dedupe + TTL cache. Two jobs:
//  1) collapse concurrent identical calls into ONE upstream request (in-flight map)
//  2) optionally serve an identical call from cache within a TTL (cut spend)
// Keyed by a stable hash of {api, path, body, query}.
export interface DedupeCacheOptions {
  readonly ttlMs?: number; // 0 = only in-flight dedupe, never serve stale
  readonly now?: () => number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class DedupeCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly settled = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(options: DedupeCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 0;
    this.now = options.now ?? Date.now;
  }

  /**
   * Runs `fn` for `key`, deduping concurrent callers and (if ttl>0) serving a
   * fresh cached value. `cacheable(value)` decides whether a result is stored.
   */
  async run<T>(key: string, fn: () => Promise<T>, cacheable: (v: T) => boolean = () => true): Promise<T> {
    if (this.ttlMs > 0) {
      const hit = this.settled.get(key);
      if (hit && hit.expiresAt > this.now()) return hit.value as T;
    }
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const p = (async () => {
      try {
        const value = await fn();
        if (this.ttlMs > 0 && cacheable(value)) {
          this.settled.set(key, { value, expiresAt: this.now() + this.ttlMs });
        }
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}

/** Stable, order-independent key for a request shape. */
export function requestKey(parts: {
  api: string;
  path: string;
  body?: Record<string, unknown> | undefined;
  query?: Record<string, string> | undefined;
}): string {
  return JSON.stringify([parts.api, parts.path, sortValue(parts.body ?? null), sortValue(parts.query ?? null)]);
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortValue((v as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return v;
}
