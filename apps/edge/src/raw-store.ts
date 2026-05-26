import { createCappedKvStore, DEFAULT_RAW_CAP_BYTES, type KvPort, type RawBlobBackend } from "@ortha/context";
import type { SqlDb } from "@ortha/db";

/**
 * DDL for the DO-local raw-result blob store. Idempotent (IF NOT EXISTS), added in
 * the Conversation DO's init() exactly like SESSION_SPEND_DDL.
 *
 * One row per tool-result requestId. `json` holds the (possibly truncated) serialized
 * value; `bytes` is the stored byte length; `created_at` is epoch ms for future
 * cap-eviction (not required in v1).
 */
export const RAW_BLOBS_DDL =
  `CREATE TABLE IF NOT EXISTS raw_blobs (
     request_id TEXT PRIMARY KEY,
     json       TEXT NOT NULL,
     bytes      INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   )`;

/**
 * Build a durable, size-capped raw-result store backed by the Conversation DO's
 * synchronous SQLite. Used as the live `rawStore` for the MemoryStore so that:
 *   - raw tool results persist across turns (cross-turn `expand_result` works), and
 *   - oversized payloads are stored as a truncated marker (never multi-hundred-KB
 *     blobs held in memory or written to SQLite).
 *
 * The capping/serialization lives in @ortha/context's `createCappedKvStore`; this
 * adapter only provides the SQLite-backed {@link RawBlobBackend}.
 */
export function createSqlRawStore(db: SqlDb, capBytes: number = DEFAULT_RAW_CAP_BYTES): KvPort<unknown> {
  const backend: RawBlobBackend = {
    getJson(key) {
      const row = db.get(`SELECT json FROM raw_blobs WHERE request_id = ?`, [key]);
      return row ? String(row.json) : null;
    },
    putJson(key, json, bytes) {
      db.run(
        `INSERT INTO raw_blobs (request_id, json, bytes, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (request_id) DO UPDATE SET
           json = excluded.json, bytes = excluded.bytes, created_at = excluded.created_at`,
        [key, json, bytes, Date.now()],
      );
    },
  };
  return createCappedKvStore(backend, capBytes);
}
