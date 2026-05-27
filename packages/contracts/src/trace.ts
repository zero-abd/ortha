import { z } from "zod";

// Streamed from the Conversation DO to the client over WebSocket. Validated on
// both ends. This is the contract lane G (frontend) renders the live agent trace,
// cost meter, and permission UI from.

const ErrorCodeEnum = z.enum([
  "INSUFFICIENT_CREDITS",
  "PROVIDER_DOWN",
  "TIMEOUT",
  "NOT_FOUND",
  "BUDGET_EXCEEDED",
  "AUTH",
  "BAD_REQUEST",
  "TOOL_UNKNOWN_STATE",
]);

export const TraceEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("token"), text: z.string() }),
  z.object({
    type: z.literal("tool_search"),
    query: z.string(),
    resultCount: z.number().int(),
    // The matched endpoints ("slug path"), ranked (recommended first) — so the trace can
    // show WHICH tools were found, not just how many. Capped by the loop.
    tools: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("tool_call_started"),
    stepId: z.string(),
    api: z.string(),
    path: z.string(),
    estCents: z.number(),
  }),
  z.object({
    type: z.literal("tool_result"),
    stepId: z.string(),
    requestId: z.string(),
    summary: z.string(),
    priceCents: z.number(),
    latencyMs: z.number().int(),
    ok: z.boolean(),
  }),
  z.object({
    type: z.literal("cost_update"),
    sessionCents: z.number(),
    capCents: z.number(),
    workspaceRemainingCents: z.number(),
  }),
  z.object({
    type: z.literal("permission_required"),
    stepId: z.string(),
    kind: z.enum(["cost", "side_effect"]),
    estCents: z.number(),
    sessionCents: z.number(),
    capCents: z.number(),
    // Present for side_effect gates: what the agent wants to do, and to what.
    action: z.string().optional(),
    target: z.string().optional(),
    // Present (true) on a cost gate forced by dynamic pricing: estCents is a floor,
    // the actual charge may be higher. The chip renders "~$X+ · price varies".
    dynamic: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("permission_resolved"),
    stepId: z.string(),
    approved: z.boolean(),
  }),
  z.object({
    type: z.literal("self_heal"),
    failedProvider: z.string(),
    altProvider: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    code: ErrorCodeEnum,
    message: z.string(),
    providerSlug: z.string().optional(),
  }),
  z.object({
    type: z.literal("done"),
    stopReason: z.enum(["end", "tool_use", "max_tokens", "error"]),
  }),
]);

export type TraceEvent = z.infer<typeof TraceEventSchema>;

/** Client → DO: the user's answer to a permission_required gate. */
export const PermissionResponseSchema = z.object({
  stepId: z.string(),
  decision: z.enum(["approve", "raise_cap", "skip", "cancel"]),
  /** New session cap in cents, when decision === "raise_cap". */
  newCapCents: z.number().int().nonnegative().optional(),
});
export type PermissionResponse = z.infer<typeof PermissionResponseSchema>;
