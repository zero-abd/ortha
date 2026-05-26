// A minimal injectable key/value port. Map-backed in tests; Cloudflare KV or D1
// in prod. Values are strings (callers serialize), so the same port works for
// both the encrypted key envelopes and the auth records.
export interface KVStore {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
  /** All keys (not values) sharing the given prefix. */
  list(prefix: string): Promise<readonly string[]>;
}

/** A Map-backed KVStore for tests and local dev. */
export function createMemoryStore(): KVStore {
  const map = new Map<string, string>();
  return {
    async put(key, value) {
      map.set(key, value);
    },
    async get(key) {
      return map.get(key) ?? null;
    },
    async del(key) {
      map.delete(key);
    },
    async list(prefix) {
      const out: string[] = [];
      for (const k of map.keys()) if (k.startsWith(prefix)) out.push(k);
      return out;
    },
  };
}
