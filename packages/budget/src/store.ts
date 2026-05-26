import type { Cents } from "@ortha/contracts";
import type { ConversationId, WorkspaceId } from "@ortha/contracts";

/**
 * The spend accounting port the BudgetPolicy delegates to. In prod this is backed
 * by @ortha/db's `tryReserveSpend` over D1 (SQLite single-writer makes the
 * conditional reserve atomic — concurrent overspend is impossible). Tests use the
 * in-memory implementation below, which mirrors that single-writer behaviour.
 *
 * Reserve→settle uses an auth/capture model: `tryReserve` holds `cents` against the
 * monthly cap, `settle` converts a hold to actual spend (releasing the unused
 * estimate − actual remainder), and `refund` releases a hold in full.
 */
export interface SpendStore {
  /**
   * Atomically reserve `cents` for the workspace iff `reserved + settled + cents <= capCents`.
   * Returns false (no mutation) when the reservation would cross the cap.
   */
  tryReserve(workspaceId: WorkspaceId, cents: Cents, capCents: Cents): Promise<boolean>;
  /** Convert a hold to actual spend: reserved -= reservationCents, settled += actualCents. */
  settle(workspaceId: WorkspaceId, reservationCents: Cents, actualCents: Cents): Promise<void>;
  /** Release a hold in full: reserved -= cents. */
  refund(workspaceId: WorkspaceId, cents: Cents): Promise<void>;
  /** capCents − reserved − settled, clamped at 0. */
  remaining(workspaceId: WorkspaceId): Promise<Cents>;

  /** Per-conversation (session) settled spend, for the soft session cap. */
  sessionSpent(conversationId: ConversationId): Promise<Cents>;
  addSessionSpent(conversationId: ConversationId, cents: Cents): Promise<void>;
}

interface WorkspaceSpend {
  reserved: Cents;
  settled: Cents;
  capCents: Cents;
}

/**
 * Single-process spend store for tests and local dev. `tryReserve` is the cap
 * gate; because JS runs the read-check-write without interleaving, two reserves
 * that together exceed the cap cannot both succeed — the second sees the first's
 * `reserved` and is rejected, exactly like the D1 conditional UPDATE.
 */
export class InMemorySpendStore implements SpendStore {
  private readonly workspaces = new Map<WorkspaceId, WorkspaceSpend>();
  private readonly sessions = new Map<ConversationId, Cents>();
  private readonly getCap: (workspaceId: WorkspaceId) => Cents;

  /**
   * @param getCap resolves a workspace's monthly cap so `remaining()` is correct
   *   even before the first reserve. Defaults to +Infinity (uncapped) when omitted.
   */
  constructor(getCap?: (workspaceId: WorkspaceId) => Cents) {
    this.getCap = getCap ?? (() => Number.POSITIVE_INFINITY);
  }

  private ws(workspaceId: WorkspaceId, capCents: Cents): WorkspaceSpend {
    let row = this.workspaces.get(workspaceId);
    if (row === undefined) {
      row = { reserved: 0, settled: 0, capCents };
      this.workspaces.set(workspaceId, row);
    } else {
      // Latest known cap wins (settings can change between calls).
      row.capCents = capCents;
    }
    return row;
  }

  async tryReserve(workspaceId: WorkspaceId, cents: Cents, capCents: Cents): Promise<boolean> {
    const row = this.ws(workspaceId, capCents);
    if (row.reserved + row.settled + cents > row.capCents) return false;
    row.reserved += cents;
    return true;
  }

  async settle(workspaceId: WorkspaceId, reservationCents: Cents, actualCents: Cents): Promise<void> {
    const row = this.workspaces.get(workspaceId);
    if (row === undefined) return;
    row.reserved = Math.max(0, row.reserved - reservationCents);
    row.settled += actualCents;
  }

  async refund(workspaceId: WorkspaceId, cents: Cents): Promise<void> {
    const row = this.workspaces.get(workspaceId);
    if (row === undefined) return;
    row.reserved = Math.max(0, row.reserved - cents);
  }

  async remaining(workspaceId: WorkspaceId): Promise<Cents> {
    const row = this.workspaces.get(workspaceId);
    if (row === undefined) return Math.max(0, this.getCap(workspaceId));
    return Math.max(0, row.capCents - row.reserved - row.settled);
  }

  async sessionSpent(conversationId: ConversationId): Promise<Cents> {
    return this.sessions.get(conversationId) ?? 0;
  }

  async addSessionSpent(conversationId: ConversationId, cents: Cents): Promise<void> {
    this.sessions.set(conversationId, (this.sessions.get(conversationId) ?? 0) + cents);
  }
}
