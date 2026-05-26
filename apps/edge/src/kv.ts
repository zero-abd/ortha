import type { KVStore } from "@ortha/auth";

/** Adapt a Cloudflare KV namespace to @ortha/auth's KVStore port. */
export function kvStore(kv: KVNamespace): KVStore {
  return {
    async put(key, value) {
      await kv.put(key, value);
    },
    async get(key) {
      return kv.get(key);
    },
    async del(key) {
      await kv.delete(key);
    },
    async list(prefix) {
      const out: string[] = [];
      let cursor: string | undefined;
      do {
        const res = cursor ? await kv.list({ prefix, cursor }) : await kv.list({ prefix });
        for (const k of res.keys) out.push(k.name);
        cursor = res.list_complete ? undefined : res.cursor;
      } while (cursor);
      return out;
    },
  };
}
