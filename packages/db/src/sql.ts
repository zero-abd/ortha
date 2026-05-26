// The tiny synchronous SQL surface the store builds on. Every backend (better-sqlite3
// today, node:sqlite, libSQL, …) implements these three methods. The store layers
// async on top so the same code can front an async backend (D1) via `d1Adapter`.
//
// Params are positional ("?"). Rows are plain objects keyed by column name.

export type SqlParam = string | number | bigint | null;
export type SqlRow = Record<string, SqlParam>;
/** What the store may pass at a bind site. `undefined` is coerced to `null` by adapters. */
export type SqlBindable = SqlParam | undefined;

export interface SqlDb {
  run(sql: string, params?: readonly SqlBindable[]): { changes: number };
  get(sql: string, params?: readonly SqlBindable[]): SqlRow | undefined;
  all(sql: string, params?: readonly SqlBindable[]): SqlRow[];
}

/**
 * Minimal structural shape of a `better-sqlite3` Database we depend on. Declared
 * locally so the package typechecks even if `@types/better-sqlite3` is absent;
 * the real Database satisfies it.
 */
// Params typed loosely (any[]) so a real `better-sqlite3` Database — whose Statement
// methods are generic — is structurally assignable without pulling in its @types.
export interface BetterSqliteStatement {
  run(...params: any[]): { changes: number | bigint };
  get(...params: any[]): unknown;
  all(...params: any[]): unknown[];
}
export interface BetterSqliteDatabase {
  prepare(sql: string): BetterSqliteStatement;
  exec(sql: string): unknown;
}

/**
 * Wrap a `better-sqlite3` Database as a `SqlDb`. Synchronous and node-native —
 * the adapter of record for tests and any Node host.
 *
 * ```ts
 * import Database from "better-sqlite3";
 * const store = createStore(betterSqliteAdapter(new Database(":memory:")));
 * ```
 */
export function betterSqliteAdapter(database: BetterSqliteDatabase): SqlDb {
  const args = (params?: readonly SqlBindable[]): readonly SqlParam[] =>
    (params ?? []).map((p) => p ?? null);
  return {
    run(sql, params) {
      const { changes } = database.prepare(sql).run(...args(params));
      return { changes: Number(changes) };
    },
    get(sql, params) {
      const row = database.prepare(sql).get(...args(params));
      return (row as SqlRow | undefined) ?? undefined;
    },
    all(sql, params) {
      return database.prepare(sql).all(...args(params)) as SqlRow[];
    },
  };
}

/**
 * Structural shape of a Cloudflare D1 Database (async). Declared locally to avoid a
 * hard dependency on `@cloudflare/workers-types`.
 */
export interface D1PreparedStatement {
  bind(...values: readonly SqlParam[]): D1PreparedStatement;
  first(): Promise<SqlRow | null>;
  all(): Promise<{ results: SqlRow[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

/** Async mirror of {@link SqlDb} for backends that cannot run synchronously (D1). */
export interface AsyncSqlDb {
  run(sql: string, params?: readonly SqlBindable[]): Promise<{ changes: number }>;
  get(sql: string, params?: readonly SqlBindable[]): Promise<SqlRow | undefined>;
  all(sql: string, params?: readonly SqlBindable[]): Promise<SqlRow[]>;
}

/**
 * Wrap a Cloudflare D1 Database as an {@link AsyncSqlDb}.
 *
 * D1 is async-only, so it cannot satisfy the synchronous `SqlDb` surface that
 * `createStore` consumes. The store is async at the seam (every method returns a
 * Promise), so a production edge build would either (a) front a synchronous
 * mirror, or (b) use an async-aware store variant. This adapter exposes D1 through
 * the {@link AsyncSqlDb} shape so that wiring is trivial; it is intentionally thin
 * and documented rather than load-bearing in tests, where better-sqlite3 is used.
 */
export function d1Adapter(d1: D1Database): AsyncSqlDb {
  const bind = (sql: string, params?: readonly SqlBindable[]): D1PreparedStatement => {
    const stmt = d1.prepare(sql);
    const norm = (params ?? []).map((p) => p ?? null);
    return norm.length > 0 ? stmt.bind(...norm) : stmt;
  };
  return {
    async run(sql, params) {
      const { meta } = await bind(sql, params).run();
      return { changes: meta.changes };
    },
    async get(sql, params) {
      return (await bind(sql, params).first()) ?? undefined;
    },
    async all(sql, params) {
      const { results } = await bind(sql, params).all();
      return results;
    },
  };
}
