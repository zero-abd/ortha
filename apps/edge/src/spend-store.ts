import type { SpendStorePort } from "@ortha/budget";
import type { AsyncSqlDb, SqlDb } from "@ortha/db";
import type { Cents, ConversationId, WorkspaceId } from "@ortha/contracts";

/**
 * Durable spend store backing the BudgetPolicy in live (BYOK) mode.
 *
 * Two scopes, two backends:
 *   - Workspace monthly spend (across conversations) → D1 (`env.DB`), keyed by
 *     (workspaceId, period='YYYY-MM' UTC). The cap is enforced inside the WHERE
 *     clause of a single conditional UPDATE, so SQLite's single-writer guarantees
 *     concurrent overspend is impossible — mirrors @ortha/db's tryReserveSpend.
 *   - Session spend (per conversation) → the Conversation DO's own SQLite
 *     (`ctx.storage.sql`), keyed by conversation_id. Since one DO instance owns one
 *     conversation, this naturally accumulates across turns.
 *
 * `remaining()` takes no cap argument (per SpendStorePort), so the store holds the
 * monthly cap, injected from settings at construction.
 */

/** UTC 'YYYY-MM' for the current billing period. */
function currentPeriod(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${y}-${m}`;
}

export interface DurableSpendStoreDeps {
  /** Async D1 handle for workspace monthly spend. */
  readonly d1: AsyncSqlDb;
  /** Synchronous DO SQLite handle for per-conversation session spend. */
  readonly doSql: SqlDb;
  /** Monthly cap (cents) for `remaining()` — injected from workspace settings. */
  readonly monthlyCapCents: Cents;
  /** Override for tests; defaults to the current UTC month. */
  readonly period?: string;
}

export class DurableSpendStore implements SpendStorePort {
  private readonly d1: AsyncSqlDb;
  private readonly doSql: SqlDb;
  private readonly monthlyCapCents: Cents;
  private readonly period: string;

  constructor(deps: DurableSpendStoreDeps) {
    this.d1 = deps.d1;
    this.doSql = deps.doSql;
    this.monthlyCapCents = deps.monthlyCapCents;
    this.period = deps.period ?? currentPeriod();
  }

  /** Idempotently materialize the (workspace, period) row before mutating it. */
  private async ensureRow(workspaceId: WorkspaceId): Promise<void> {
    await this.d1.run(
      `INSERT OR IGNORE INTO workspace_spend (workspace_id, period) VALUES (?, ?)`,
      [workspaceId, this.period],
    );
  }

  async tryReserve(workspaceId: WorkspaceId, cents: Cents, capCents: Cents): Promise<boolean> {
    await this.ensureRow(workspaceId);
    // The one atomic, conditional reservation: reserved + settled + new must fit the cap.
    const { changes } = await this.d1.run(
      `UPDATE workspace_spend
         SET reserved_cents = reserved_cents + ?
       WHERE workspace_id = ?
         AND period = ?
         AND reserved_cents + settled_cents + ? <= ?`,
      [cents, workspaceId, this.period, cents, capCents],
    );
    return changes === 1;
  }

  async settle(workspaceId: WorkspaceId, reservationCents: Cents, actualCents: Cents): Promise<void> {
    await this.d1.run(
      `UPDATE workspace_spend
         SET reserved_cents = MAX(0, reserved_cents - ?),
             settled_cents  = settled_cents + ?
       WHERE workspace_id = ?
         AND period = ?`,
      [reservationCents, actualCents, workspaceId, this.period],
    );
  }

  async refund(workspaceId: WorkspaceId, cents: Cents): Promise<void> {
    await this.d1.run(
      `UPDATE workspace_spend
         SET reserved_cents = MAX(0, reserved_cents - ?)
       WHERE workspace_id = ?
         AND period = ?`,
      [cents, workspaceId, this.period],
    );
  }

  async remaining(workspaceId: WorkspaceId): Promise<Cents> {
    const row = await this.d1.get(
      `SELECT reserved_cents, settled_cents FROM workspace_spend
       WHERE workspace_id = ? AND period = ?`,
      [workspaceId, this.period],
    );
    if (!row) return Math.max(0, this.monthlyCapCents);
    const reserved = Number(row.reserved_cents ?? 0);
    const settled = Number(row.settled_cents ?? 0);
    return Math.max(0, this.monthlyCapCents - reserved - settled);
  }

  async sessionSpent(conversationId: ConversationId): Promise<Cents> {
    const row = this.doSql.get(
      `SELECT cents FROM session_spend WHERE conversation_id = ?`,
      [conversationId],
    );
    return row ? Number(row.cents ?? 0) : 0;
  }

  async addSessionSpent(conversationId: ConversationId, cents: Cents): Promise<void> {
    // Upsert-add: insert at `cents` or accumulate onto the existing row.
    this.doSql.run(
      `INSERT INTO session_spend (conversation_id, cents) VALUES (?, ?)
       ON CONFLICT (conversation_id) DO UPDATE SET cents = cents + excluded.cents`,
      [conversationId, cents],
    );
  }
}

/** DDL for the DO-local session spend table. Idempotent (IF NOT EXISTS). */
export const SESSION_SPEND_DDL =
  `CREATE TABLE IF NOT EXISTS session_spend (
     conversation_id TEXT PRIMARY KEY,
     cents           INTEGER NOT NULL DEFAULT 0
   )`;

/** DDL for the D1 workspace monthly spend table. Idempotent (IF NOT EXISTS). */
export const WORKSPACE_SPEND_DDL =
  `CREATE TABLE IF NOT EXISTS workspace_spend (
     workspace_id   TEXT NOT NULL,
     period         TEXT NOT NULL,
     reserved_cents INTEGER NOT NULL DEFAULT 0,
     settled_cents  INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (workspace_id, period)
   )`;
