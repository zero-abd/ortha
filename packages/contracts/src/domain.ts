import { z } from "zod";
import type {
  ConversationId,
  IdempotencyKey,
  MessageId,
  RequestId,
  ToolCallId,
  UserId,
  WorkspaceId,
} from "./ids.js";

/** Money is always integer cents. priceCents from Orthogonal is the source unit. */
export type Cents = number;

export type Role = "owner" | "admin" | "member";
export type MessageRole = "user" | "assistant" | "system" | "tool";

/** Lifecycle of a single tool execution, mirrored in the durable call journal. */
export type ToolCallStatus = "pending" | "settled" | "unknown" | "failed";

export interface User {
  readonly id: UserId;
  readonly email: string;
  readonly displayName: string | null;
  readonly createdAt: number;
}

export interface Workspace {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly createdAt: number;
}

export interface Membership {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly role: Role;
}

export interface Conversation {
  readonly id: ConversationId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Message {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: number;
  /** Tool calls produced while generating this (assistant) message. */
  readonly toolCallIds: readonly ToolCallId[];
  /**
   * role==="assistant": the full tool calls this turn requested (id + name + args),
   * so the transcript replays faithfully and the model can `expand_result` a prior
   * call across turns.
   */
  readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly args: Record<string, unknown> }[];
  /** role==="tool": which assistant tool_call this result answers. */
  readonly toolCallId?: string;
  /** role==="tool": the tool's name (providers like Gemini require it on the result). */
  readonly toolName?: string;
  /** role==="tool": what the call cost / how long it took, persisted so a reopened
   *  conversation shows price + latency on the restored trace block (not just api·path). */
  readonly priceCents?: number;
  readonly latencyMs?: number;
}

export interface ToolCall {
  readonly id: ToolCallId;
  readonly conversationId: ConversationId;
  readonly api: string;
  readonly path: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly status: ToolCallStatus;
  readonly priceCents: Cents | null;
  readonly latencyMs: number | null;
  readonly requestId: RequestId | null;
  readonly createdAt: number;
}

/**
 * Durable journal row enabling at-least-once tool execution + reconciliation.
 * Written `pending` BEFORE calling Orthogonal, flipped to `settled` after.
 * A row stuck `pending`/`unknown` after a crash is reconciled against /v1/usage
 * before any re-charge.
 */
export interface CallJournalEntry {
  readonly idempotencyKey: IdempotencyKey;
  readonly conversationId: ConversationId;
  readonly stepId: string;
  readonly state: "pending" | "settled" | "unknown";
  readonly requestId: RequestId | null;
  readonly priceCents: Cents | null;
  readonly createdAt: number;
}

/** Per-workspace, per-period spend accounting. Cap enforced via D1 atomic UPDATE. */
export interface SpendRecord {
  readonly workspaceId: WorkspaceId;
  readonly periodStart: number;
  readonly reservedCents: Cents;
  readonly settledCents: Cents;
  readonly capCents: Cents;
}

export type ThemePreference = "system" | "light" | "dark";

export const SettingsSchema = z.object({
  /** Per-session soft cap; crossing it triggers the inline spend permission chip. */
  sessionCapCents: z.number().int().nonnegative(),
  /** Single-call cost above which we warn before spending. */
  perCallWarnCents: z.number().int().nonnegative(),
  /** Hard per-workspace monthly cap; cannot be overridden by a session. */
  monthlyCapCents: z.number().int().nonnegative(),
  /** Selected model id from the ModelRegistry. */
  model: z.string().min(1),
  theme: z.enum(["system", "light", "dark"]),
  /** Seconds an identical tool result may be served from cache. */
  cacheTtlSeconds: z.number().int().nonnegative(),
});

export type Settings = z.infer<typeof SettingsSchema>;

/** Observed per-provider reliability/cost, feeding the future quality-aware planner. */
export interface ProviderStats {
  readonly slug: string;
  readonly successCount: number;
  readonly failureCount: number;
  readonly p50LatencyMs: number;
  readonly avgCostCents: Cents;
}
