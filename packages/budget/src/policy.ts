import {
  type BudgetDecision,
  type BudgetPolicy,
  type Cents,
  type ConversationId,
  type IdempotencyKey,
  type ReservationId,
  type Settings,
  type WorkspaceId,
  ErrorCode,
  OrthaError,
} from "@ortha/contracts";

/**
 * Settings the policy needs per workspace. A full `Settings` satisfies this, so
 * callers can pass `store.getSettings`. The two caps plus the per-call warn
 * threshold are read here.
 */
export type BudgetSettings = Pick<Settings, "sessionCapCents" | "monthlyCapCents" | "perCallWarnCents">;

/** The spend accounting port the policy delegates to. */
export interface SpendStorePort {
  tryReserve(workspaceId: WorkspaceId, cents: Cents, capCents: Cents): Promise<boolean>;
  settle(workspaceId: WorkspaceId, reservationCents: Cents, actualCents: Cents): Promise<void>;
  refund(workspaceId: WorkspaceId, cents: Cents): Promise<void>;
  remaining(workspaceId: WorkspaceId): Promise<Cents>;
  sessionSpent(conversationId: ConversationId): Promise<Cents>;
  addSessionSpent(conversationId: ConversationId, cents: Cents): Promise<void>;
}

export interface BudgetPolicyDeps {
  readonly store: SpendStorePort;
  /** Resolves per-workspace caps. Accepts a plain `Settings`-shaped object or a getter. */
  readonly settings: BudgetSettings | ((workspaceId: WorkspaceId) => BudgetSettings | Promise<BudgetSettings>);
}

/** What we remember between reserve and settle/refund. */
interface Hold {
  readonly workspaceId: WorkspaceId;
  readonly estimateCents: Cents;
  /** Captured at checkEstimate so settle can attribute actual spend to the session. */
  readonly conversationId: ConversationId | undefined;
}

let counter = 0;
const newReservationId = (): ReservationId => `rsv_${Date.now().toString(36)}_${(counter++).toString(36)}` as ReservationId;

/**
 * Creates a {@link BudgetPolicy} over an injectable spend store.
 *
 * Conversation/session scoping: the frozen `reserve(ws, estimate, key)` seam has
 * no conversationId, but `settle` must attribute actual spend to a session. We
 * bridge this by remembering the conversationId seen in the most recent
 * `checkEstimate(ws, conv, …)` for that workspace, and stamping it onto the hold at
 * `reserve` time. The intended caller flow is checkEstimate → reserve → settle on
 * the same workspace, so the binding is correct; if `reserve` is ever called for a
 * workspace that was never checked, session spend simply isn't recorded (the hard
 * workspace cap still fully protects against overspend).
 */
export function createBudgetPolicy(deps: BudgetPolicyDeps): BudgetPolicy {
  const { store } = deps;
  const getSettings: (workspaceId: WorkspaceId) => BudgetSettings | Promise<BudgetSettings> =
    typeof deps.settings === "function" ? deps.settings : () => deps.settings as BudgetSettings;

  /** Keyed by idempotencyKey for replay-safety: re-reserving a key returns its existing hold. */
  const holds = new Map<IdempotencyKey, { reservationId: ReservationId; hold: Hold }>();
  const byReservationId = new Map<ReservationId, IdempotencyKey>();
  /** Last conversation observed per workspace via checkEstimate. */
  const lastConversation = new Map<WorkspaceId, ConversationId>();

  return {
    async checkEstimate(
      workspaceId: WorkspaceId,
      conversationId: ConversationId,
      estimateCents: Cents,
    ): Promise<BudgetDecision> {
      lastConversation.set(workspaceId, conversationId);

      const { sessionCapCents, perCallWarnCents } = await getSettings(workspaceId);
      const workspaceRemainingCents = await store.remaining(workspaceId);
      const sessionSpentCents = await store.sessionSpent(conversationId);

      const base = { sessionSpentCents, sessionCapCents, workspaceRemainingCents } as const;

      // Hard ceiling first: a single estimate that can't fit the workspace cap is denied.
      if (workspaceRemainingCents - estimateCents < 0) {
        return {
          decision: "denied",
          reason: `Estimated ${estimateCents}¢ exceeds the workspace's remaining ${workspaceRemainingCents}¢ this period.`,
          ...base,
        };
      }

      // Per-call warn: a single expensive call needs approval, even if it fits the
      // session cap. Distinct reason from the session-cap check below.
      if (perCallWarnCents > 0 && estimateCents >= perCallWarnCents) {
        return {
          decision: "permission_required",
          reason: `This single call is estimated at ${estimateCents}¢, at/above your per-call warn threshold of ${perCallWarnCents}¢.`,
          ...base,
        };
      }

      // Soft ceiling: crossing the session cap needs an inline permission approval.
      if (sessionSpentCents + estimateCents > sessionCapCents) {
        return {
          decision: "permission_required",
          reason: `This call would bring session spend to ${sessionSpentCents + estimateCents}¢, over the ${sessionCapCents}¢ session cap.`,
          ...base,
        };
      }

      return { decision: "ok", reason: "Within budget.", ...base };
    },

    async reserve(
      workspaceId: WorkspaceId,
      estimateCents: Cents,
      idempotencyKey: IdempotencyKey,
    ): Promise<ReservationId> {
      // Replay safety: the same key always maps to the same hold; never double-charge.
      const existing = holds.get(idempotencyKey);
      if (existing !== undefined) return existing.reservationId;

      const { monthlyCapCents } = await getSettings(workspaceId);
      const ok = await store.tryReserve(workspaceId, estimateCents, monthlyCapCents);
      if (!ok) {
        throw new OrthaError(
          ErrorCode.BUDGET_EXCEEDED,
          `Reserving ${estimateCents}¢ would cross the workspace monthly cap of ${monthlyCapCents}¢.`,
        );
      }

      const reservationId = newReservationId();
      const hold: Hold = {
        workspaceId,
        estimateCents,
        conversationId: lastConversation.get(workspaceId),
      };
      holds.set(idempotencyKey, { reservationId, hold });
      byReservationId.set(reservationId, idempotencyKey);
      return reservationId;
    },

    async settle(reservationId: ReservationId, actualCents: Cents): Promise<void> {
      const key = byReservationId.get(reservationId);
      const entry = key === undefined ? undefined : holds.get(key);
      if (key === undefined || entry === undefined) return; // already settled/refunded — idempotent no-op

      const { workspaceId, estimateCents, conversationId } = entry.hold;
      // Reduce reserved by the original estimate, add settled by the actual; this
      // releases the (estimate − actual) difference back to the workspace cap.
      await store.settle(workspaceId, estimateCents, actualCents);
      if (conversationId !== undefined) {
        await store.addSessionSpent(conversationId, actualCents);
      }

      holds.delete(key);
      byReservationId.delete(reservationId);
    },

    async refund(reservationId: ReservationId): Promise<void> {
      const key = byReservationId.get(reservationId);
      const entry = key === undefined ? undefined : holds.get(key);
      if (key === undefined || entry === undefined) return; // already settled/refunded — idempotent no-op

      const { workspaceId, estimateCents } = entry.hold;
      await store.refund(workspaceId, estimateCents);

      holds.delete(key);
      byReservationId.delete(reservationId);
    },

    async remaining(workspaceId: WorkspaceId): Promise<Cents> {
      return store.remaining(workspaceId);
    },
  };
}
