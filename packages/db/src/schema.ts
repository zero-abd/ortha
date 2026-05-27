// Relational schema for the ConversationStore. Columns mirror @ortha/contracts
// domain shapes 1:1. Money is integer cents. Timestamps are epoch millis (INTEGER).
//
// Written to be portable across SQLite engines (better-sqlite3, node:sqlite, D1):
// no engine-specific types, no triggers — just tables, PKs, FKs, and the two
// uniqueness/atomicity guarantees the store relies on:
//   - call_journal.idempotencyKey is the PRIMARY KEY  → journalPending is write-once.
//   - spend is keyed by (workspaceId, periodStart)     → tryReserveSpend is one UPDATE.

import type { SqlDb } from "./sql.js";

export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    displayName TEXT,
    createdAt   INTEGER NOT NULL,
    saltB64     TEXT,
    hashB64     TEXT
  )`,
  // Email is the login identifier — unique + indexed for findByEmail.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email)`,

  `CREATE TABLE IF NOT EXISTS workspaces (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS memberships (
    userId      TEXT NOT NULL,
    workspaceId TEXT NOT NULL,
    role        TEXT NOT NULL,
    PRIMARY KEY (userId, workspaceId)
  )`,

  `CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    workspaceId TEXT NOT NULL,
    title       TEXT NOT NULL,
    createdAt   INTEGER NOT NULL,
    updatedAt   INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_workspace
     ON conversations (workspaceId, createdAt)`,

  `CREATE TABLE IF NOT EXISTS messages (
    id             TEXT PRIMARY KEY,
    conversationId TEXT NOT NULL,
    role           TEXT NOT NULL,
    content        TEXT NOT NULL,
    createdAt      INTEGER NOT NULL,
    seq            INTEGER NOT NULL,
    toolCallIds    TEXT NOT NULL DEFAULT '[]',
    -- JSON tool metadata for faithful transcript replay: assistant tool_calls
    -- (id+name+args) or a tool result's {toolCallId,toolName}. Enables cross-turn
    -- expand_result by keeping requestId-bearing tool messages in history.
    toolMeta       TEXT NOT NULL DEFAULT '{}'
  )`,
  // Ordering within a conversation is (createdAt, seq); seq breaks ties for
  // messages appended in the same millisecond, keeping loadWindow deterministic.
  `CREATE INDEX IF NOT EXISTS idx_messages_conversation
     ON messages (conversationId, createdAt, seq)`,

  `CREATE TABLE IF NOT EXISTS tool_calls (
    id             TEXT PRIMARY KEY,
    conversationId TEXT NOT NULL,
    api            TEXT NOT NULL,
    path           TEXT NOT NULL,
    idempotencyKey TEXT NOT NULL,
    status         TEXT NOT NULL,
    priceCents     INTEGER,
    latencyMs      INTEGER,
    requestId      TEXT,
    createdAt      INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_conversation
     ON tool_calls (conversationId, createdAt)`,

  // Write-once durable journal. idempotencyKey is the PK: a second INSERT for the
  // same key fails the uniqueness constraint, which is how journalPending detects
  // an already-journaled call.
  `CREATE TABLE IF NOT EXISTS call_journal (
    idempotencyKey TEXT PRIMARY KEY,
    conversationId TEXT NOT NULL,
    stepId         TEXT NOT NULL,
    state          TEXT NOT NULL,
    requestId      TEXT,
    priceCents     INTEGER,
    createdAt      INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_call_journal_state
     ON call_journal (state)`,

  `CREATE TABLE IF NOT EXISTS summaries (
    conversationId TEXT NOT NULL,
    upToSeq        INTEGER NOT NULL,
    content        TEXT NOT NULL,
    createdAt      INTEGER NOT NULL,
    PRIMARY KEY (conversationId, upToSeq)
  )`,

  // One settings row per workspace. Stored denormalized as columns (not JSON) so
  // future migrations and ad-hoc queries are straightforward.
  `CREATE TABLE IF NOT EXISTS settings (
    workspaceId      TEXT PRIMARY KEY,
    sessionCapCents  INTEGER NOT NULL,
    perCallWarnCents INTEGER NOT NULL,
    monthlyCapCents  INTEGER NOT NULL,
    model            TEXT NOT NULL,
    theme            TEXT NOT NULL,
    cacheTtlSeconds  INTEGER NOT NULL
  )`,

  // Per-workspace, per-period spend accounting. The (workspaceId, periodStart) PK
  // is what lets tryReserveSpend be a single atomic conditional UPDATE.
  `CREATE TABLE IF NOT EXISTS spend (
    workspaceId   TEXT NOT NULL,
    periodStart   INTEGER NOT NULL,
    reservedCents INTEGER NOT NULL DEFAULT 0,
    settledCents  INTEGER NOT NULL DEFAULT 0,
    capCents      INTEGER NOT NULL,
    PRIMARY KEY (workspaceId, periodStart)
  )`,

  `CREATE TABLE IF NOT EXISTS provider_stats (
    slug         TEXT PRIMARY KEY,
    successCount INTEGER NOT NULL DEFAULT 0,
    failureCount INTEGER NOT NULL DEFAULT 0,
    p50LatencyMs INTEGER NOT NULL DEFAULT 0,
    avgCostCents INTEGER NOT NULL DEFAULT 0
  )`,
];

/** The full schema as one script (handy for D1 migrations / `exec`). */
export const SCHEMA_SQL: string = SCHEMA_STATEMENTS.map((s) => `${s};`).join("\n\n");

/**
 * Idempotent column additions for databases created before a column existed.
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so each runs in a try/catch and a
 * "duplicate column" error on an already-migrated DB is expected and ignored.
 */
const MIGRATION_STATEMENTS: readonly string[] = [
  `ALTER TABLE messages ADD COLUMN toolMeta TEXT NOT NULL DEFAULT '{}'`,
  // Password credentials for email/password users (null for OAuth-only users).
  `ALTER TABLE users ADD COLUMN saltB64 TEXT`,
  `ALTER TABLE users ADD COLUMN hashB64 TEXT`,
];

/** Apply the schema to a synchronous {@link SqlDb}. Idempotent (IF NOT EXISTS + guarded migrations). */
export function applySchema(db: SqlDb): void {
  for (const stmt of SCHEMA_STATEMENTS) db.run(stmt);
  for (const stmt of MIGRATION_STATEMENTS) {
    try {
      db.run(stmt);
    } catch {
      // Column already present (table predates this migration's CREATE) — fine.
    }
  }
}
