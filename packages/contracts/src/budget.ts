import type { Cents } from "./domain.js";
import type { Brand, ConversationId, IdempotencyKey, WorkspaceId } from "./ids.js";

/** Handle for a reserve→settle/refund lifecycle (auth/capture for spend). */
export type ReservationId = Brand<string, "ReservationId">;

export type BudgetOutcome = "ok" | "permission_required" | "denied";

export interface BudgetDecision {
  readonly decision: BudgetOutcome;
  /** Human reason, shown in the permission chip when `permission_required`. */
  readonly reason: string;
  readonly sessionSpentCents: Cents;
  readonly sessionCapCents: Cents;
  readonly workspaceRemainingCents: Cents;
}

/**
 * Enforces spend caps. Workspace cap is the hard ceiling (D1 atomic conditional
 * UPDATE — SQLite single-writer makes concurrent overspend impossible). Session
 * cap is the soft ceiling that triggers the inline permission chip.
 *
 * Flow per paid call: checkEstimate → (if ok or approved) reserve(estimate) →
 * run → settle(actual) | refund (on failure / cheaper-than-estimate remainder).
 */
export interface BudgetPolicy {
  checkEstimate(
    workspaceId: WorkspaceId,
    conversationId: ConversationId,
    estimateCents: Cents,
  ): Promise<BudgetDecision>;

  /** Atomically holds `estimateCents` against the workspace cap. Throws BUDGET_EXCEEDED. */
  reserve(
    workspaceId: WorkspaceId,
    estimateCents: Cents,
    idempotencyKey: IdempotencyKey,
  ): Promise<ReservationId>;

  /** Converts a hold to actual spend; releases (actual - estimate) difference. */
  settle(reservationId: ReservationId, actualCents: Cents): Promise<void>;

  /** Releases a hold entirely (call failed / was skipped). */
  refund(reservationId: ReservationId): Promise<void>;

  remaining(workspaceId: WorkspaceId): Promise<Cents>;
}
