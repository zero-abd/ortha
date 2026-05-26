import type { SqlBindable, SqlDb, SqlRow } from "@ortha/db";

/**
 * Adapts a Durable Object's synchronous SQLite (ctx.storage.sql) to @ortha/db's
 * SqlDb port. DO SQLite is the source of truth for live conversation state; this
 * is why the store is sync — it runs *inside* the DO, not against async D1.
 */
export function doSqlAdapter(sql: SqlStorage): SqlDb {
  const norm = (params?: readonly SqlBindable[]): SqlBindable[] => (params ?? []).map((p) => p ?? null);
  return {
    run(query, params) {
      sql.exec(query, ...norm(params));
      const row = sql.exec("SELECT changes() AS c").one() as { c: number };
      return { changes: Number(row.c) };
    },
    get(query, params) {
      return (sql.exec(query, ...norm(params)).toArray()[0] as SqlRow | undefined) ?? undefined;
    },
    all(query, params) {
      return sql.exec(query, ...norm(params)).toArray() as unknown as SqlRow[];
    },
  };
}
