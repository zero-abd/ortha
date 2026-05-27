import {
  asIdempotencyKey,
  asRequestId,
  ErrorCode,
  isOrthaError,
  type BudgetPolicy,
  type ConversationId,
  type IdempotencyKey,
  type LLMMessage,
  type LLMProvider,
  type MemoryStore,
  type OrthogonalClient,
  type PermissionResponse,
  type ReservationId,
  type SideEffectClass,
  type ToolApi,
  type TraceEvent,
  type WorkspaceId,
} from "@ortha/contracts";
import { distill, requestKey } from "@ortha/harness";
import {
  asRecord,
  asString,
  asStringRecord,
  EXPAND_RESULT,
  GET_TOOL_DETAILS,
  META_TOOLS,
  RUN_TOOL,
  SEARCH_TOOLS,
  SYSTEM_PROMPT,
} from "./tools.js";

/** Snapshot persisted after every step so a crashed turn can be resumed/audited. */
export interface AgentState {
  readonly messages: readonly LLMMessage[];
  readonly step: number;
  readonly sessionCents: number;
}

export interface AgentDeps {
  readonly llm: LLMProvider;
  readonly orthogonal: OrthogonalClient;
  readonly budget: BudgetPolicy;
  readonly memory: MemoryStore;
  readonly model: string;
  readonly workspaceId: WorkspaceId;
  readonly conversationId: ConversationId;
  /** Resolves an inline spend / side-effect gate. */
  readonly requestPermission: (event: Extract<TraceEvent, { type: "permission_required" }>) => Promise<PermissionResponse>;
  /** Durable checkpoint, called after each step. */
  readonly checkpoint: (state: AgentState) => Promise<void>;
  /**
   * Called as each assistant/tool message is appended to the transcript, so the
   * transport can persist the full turn (including tool calls + results with their
   * requestIds) — this is what lets a later turn `expand_result` a prior call.
   */
  readonly onMessage?: (message: LLMMessage) => Promise<void> | void;
  /** Hard ceiling on output tokens per LLM turn. Defaults to 1024. */
  readonly maxTokens?: number;
  /** Max tool-using iterations before forcing a stop. Defaults to 8. */
  readonly maxIterations?: number;
}

export interface AgentInput {
  readonly messages: readonly LLMMessage[];
}

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_MAX_ITERATIONS = 8;
/** How many times we nudge a model that narrates a next tool action without
 *  emitting the call, before accepting its turn as final. Bounds wasted turns. */
const MAX_AUTO_CONTINUE = 2;

// The model sometimes ends a turn narrating a next tool action ("I'll search for
// another tool") as plain text WITHOUT emitting the call — which would otherwise
// terminate the turn with an incomplete answer. Detect that so the loop can nudge
// it to actually act. Kept tight (an intent verb tied to a first-person plan) and
// guarded by CLOSER_RE so ordinary sign-offs ("let me know…") don't trigger it.
const CONTINUE_INTENT_RE =
  /\b(?:i'?ll|i will|i'?m going to|i am going to|let me|let'?s|next,?\s*i|now i|i should|i need to)\b[^.?!]*?\b(?:search|look|find|check|use|call|run|fetch|query|retrieve|enrich|scrape|inspect|try|another tool|a different tool|other tool|get_tool_details|run_tool|search_tools)\b/i;
const CLOSER_RE = /\b(?:let me know|let us know|feel free|happy to help)\b/i;

function looksLikeUnfulfilledIntent(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (CLOSER_RE.test(t)) return false;
  return CONTINUE_INTENT_RE.test(t);
}

const CONTINUE_NUDGE =
  "Continue now: make the tool call you just described (search_tools / get_tool_details / run_tool), or give your final answer in plain language. Do not reply again with only a description of what you intend to do.";

interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** What get_tool_details recorded about an endpoint, used to gate the later run. */
interface EndpointInfo {
  readonly sideEffect: SideEffectClass;
  readonly longRunning: boolean;
}

/**
 * The portable orchestration loop. A pure async generator driven entirely by the
 * injected ports — no Cloudflare, no Durable Object coupling. Yields the TraceEvent
 * union; the transport layer relays these over the wire.
 */
export async function* runAgentTurn(deps: AgentDeps, input: AgentInput): AsyncIterable<TraceEvent> {
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxIterations = deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  const messages: LLMMessage[] = [...input.messages];
  let sessionCents = 0;
  let stepCounter = 0;
  let autoContinues = 0;
  // Side-effect class per endpoint, recorded as the model inspects tools with
  // get_tool_details. run() reads it (gateway-authoritative, not model-asserted) to
  // gate genuine writes behind a confirmation modal.
  const sideEffects = new Map<string, EndpointInfo>();

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const pending: ToolCallRequest[] = [];
      let assistantText = "";
      let streamStopReason: "end" | "tool_use" | "max_tokens" | "error" = "end";

      // ── 1. Stream one model turn, relaying tokens and capturing tool calls ──
      for await (const event of deps.llm.streamCompletion({
        model: deps.model,
        system: SYSTEM_PROMPT,
        messages,
        tools: META_TOOLS,
        maxTokens,
      })) {
        switch (event.type) {
          case "token":
            assistantText += event.text;
            yield { type: "token", text: event.text };
            break;
          case "tool_call_request":
            pending.push({ id: event.id, name: event.name, args: event.args });
            break;
          case "usage":
            // LLM token spend is accounted elsewhere; the cost meter here tracks tool spend.
            break;
          case "done":
            streamStopReason = event.stopReason;
            break;
        }
      }

      // Record the assistant turn into the transcript. Carry the FULL tool calls
      // (id + name + args), not just ids: replaying an assistant turn without its
      // tool_calls orphans the following tool result and every provider rejects it.
      if (assistantText.length > 0 || pending.length > 0) {
        const toolCalls = pending.map((p) => ({ id: p.id, name: p.name, args: p.args }));
        const assistantMsg: LLMMessage = {
          role: "assistant",
          content: assistantText,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        };
        messages.push(assistantMsg);
        await deps.onMessage?.(assistantMsg);
      }

      // ── 2. No tool calls. Either the model answered, or it narrated a next
      //       tool action without emitting it — in which case nudge it to act
      //       rather than ending the turn with an incomplete answer (bounded). ──
      if (pending.length === 0) {
        if (autoContinues < MAX_AUTO_CONTINUE && looksLikeUnfulfilledIntent(assistantText)) {
          autoContinues += 1;
          // Ephemeral nudge: appended for the next model call but intentionally NOT
          // sent to onMessage, so it never appears in the user-visible transcript.
          messages.push({ role: "user", content: CONTINUE_NUDGE });
          await checkpoint(deps, messages, ++stepCounter, sessionCents);
          continue;
        }
        await checkpoint(deps, messages, ++stepCounter, sessionCents);
        yield { type: "done", stopReason: streamStopReason === "max_tokens" ? "max_tokens" : "end" };
        return;
      }

      // ── 3. Dispatch each requested tool call. ──
      for (const call of pending) {
        const result = yield* dispatch(deps, call, ++stepCounter, sessionCents, sideEffects);
        if (result.kind === "cancelled") {
          await checkpoint(deps, messages, stepCounter, sessionCents);
          yield { type: "done", stopReason: "end" };
          return;
        }
        sessionCents = result.sessionCents;
        const toolMsg = toolMessage(call.id, call.name, result.toolContent);
        messages.push(toolMsg);
        await deps.onMessage?.(toolMsg);
      }

      await checkpoint(deps, messages, stepCounter, sessionCents);
    }

    // ── 4. Hit the iteration cap without a final answer. ──
    yield { type: "done", stopReason: "max_tokens" };
  } catch (err) {
    yield* emitError(err);
  }
}

// ── Tool dispatch ────────────────────────────────────────────────────────────

type DispatchResult =
  | { readonly kind: "ok"; readonly sessionCents: number; readonly toolContent: string }
  | { readonly kind: "cancelled" };

async function* dispatch(
  deps: AgentDeps,
  call: ToolCallRequest,
  stepId: number,
  sessionCents: number,
  sideEffects: Map<string, EndpointInfo>,
): AsyncGenerator<TraceEvent, DispatchResult> {
  switch (call.name) {
    case SEARCH_TOOLS:
      return yield* dispatchSearch(deps, call, sessionCents);
    case GET_TOOL_DETAILS:
      return yield* dispatchDetails(deps, call, sessionCents, sideEffects);
    case RUN_TOOL:
      return yield* dispatchRun(deps, call, stepId, sessionCents, sideEffects);
    case EXPAND_RESULT:
      return yield* dispatchExpand(deps, call, sessionCents);
    default:
      return { kind: "ok", sessionCents, toolContent: `Unknown tool "${call.name}".` };
  }
}

async function* dispatchSearch(
  deps: AgentDeps,
  call: ToolCallRequest,
  sessionCents: number,
): AsyncGenerator<TraceEvent, DispatchResult> {
  const query = asString(call.args["query"]) ?? "";
  const results = await deps.orthogonal.search({ prompt: query });
  yield { type: "tool_search", query, resultCount: results.length };
  return { kind: "ok", sessionCents, toolContent: summarizeSearch(query, results) };
}

async function* dispatchDetails(
  deps: AgentDeps,
  call: ToolCallRequest,
  sessionCents: number,
  sideEffects: Map<string, EndpointInfo>,
): AsyncGenerator<TraceEvent, DispatchResult> {
  const api = asString(call.args["api"]);
  const path = asString(call.args["path"]);
  if (!api || !path) {
    return { kind: "ok", sessionCents, toolContent: "get_tool_details requires both 'api' and 'path'." };
  }
  const details = await deps.orthogonal.getDetails(api, path);
  // Record the authoritative gate info so dispatchRun can gate a write or refuse a long-op.
  sideEffects.set(`${api} ${path}`, { sideEffect: details.sideEffect, longRunning: details.longRunning });
  return { kind: "ok", sessionCents, toolContent: JSON.stringify(details) };
}

async function* dispatchExpand(
  deps: AgentDeps,
  call: ToolCallRequest,
  sessionCents: number,
): AsyncGenerator<TraceEvent, DispatchResult> {
  const requestId = asString(call.args["requestId"]) ?? "";
  const raw = await deps.memory.getRaw(asRequestId(requestId));
  const toolContent = raw === null ? `No raw result found for requestId "${requestId}".` : safeJson(raw);
  return { kind: "ok", sessionCents, toolContent };
}

async function* dispatchRun(
  deps: AgentDeps,
  call: ToolCallRequest,
  stepId: number,
  sessionCents: number,
  sideEffects: Map<string, EndpointInfo>,
): AsyncGenerator<TraceEvent, DispatchResult> {
  const api = asString(call.args["api"]);
  const path = asString(call.args["path"]);
  if (!api || !path) {
    return { kind: "ok", sessionCents, toolContent: "run_tool requires both 'api' and 'path'." };
  }
  const body = asRecord(call.args["body"]);
  const query = asStringRecord(call.args["query"]);
  const method = asString(call.args["method"]);
  const stepLabel = `step_${stepId}`;

  // Deterministic, replay-safe idempotency key: stable request shape + this step.
  const baseKey = requestKey({ api, path, body, query });
  const idempotencyKey: IdempotencyKey = asIdempotencyKey(`${baseKey}::${stepLabel}`);

  // Long-running submit→poll endpoints (crawls, deep research) can't finish in the 30s
  // fetch window and would abort-but-charge. Refuse to auto-run and let the model pick a
  // synchronous alternative. Gateway-authoritative — recorded by get_tool_details.
  const info = sideEffects.get(`${api} ${path}`);
  if (info?.longRunning) {
    return {
      kind: "ok",
      sessionCents,
      toolContent: `${api} ${path} is a long-running (submit→poll) endpoint and isn't auto-callable — it would time out at 30s and may still be charged. Pick a synchronous alternative.`,
    };
  }

  // ── Budget pre-flight ──
  const estimate = await deps.orthogonal.estimateCost([{ api, path, expectedCalls: 1, ...(method ? { method } : {}) }]);
  const estCents = estimate.estimatedCents;
  // A dynamic price means estCents is a FLOOR, not the exact charge. We force an
  // explicit approval even when the budget check would pass, so a "watch it spend"
  // user okays a call that may settle higher than the meter shows.
  const isDynamic = estimate.hasDynamicPricing;
  // A genuine write always requires an explicit confirmation modal, regardless of cost.
  // Read from the recorded getDetails classification — gateway-authoritative, so the
  // model can't talk its way past the gate by mislabeling a call.
  const isWrite = info?.sideEffect === "write";
  const decision = await deps.budget.checkEstimate(deps.workspaceId, deps.conversationId, estCents);

  if (decision.decision === "denied") {
    yield {
      type: "error",
      code: ErrorCode.BUDGET_EXCEEDED,
      message: decision.reason || "spend would exceed the workspace cap",
    };
    return { kind: "cancelled" };
  }

  if (decision.decision === "permission_required" || isDynamic || isWrite) {
    // A write escalates to the side-effect modal (names the action + target + cost);
    // otherwise it's an inline cost chip.
    const kind: "cost" | "side_effect" = isWrite ? "side_effect" : "cost";
    const gate = {
      type: "permission_required" as const,
      stepId: stepLabel,
      kind,
      estCents,
      sessionCents: decision.sessionSpentCents,
      capCents: decision.sessionCapCents,
      ...(isWrite ? { action: `${(method ?? "Call").toUpperCase()} ${api} ${path}`, target: api } : {}),
      ...(isDynamic && !isWrite ? { dynamic: true } : {}),
    };
    yield gate;
    const response = await deps.requestPermission(gate);

    switch (response.decision) {
      case "skip":
        yield { type: "permission_resolved", stepId: stepLabel, approved: false };
        return { kind: "ok", sessionCents, toolContent: `User skipped the ${api} ${path} call.` };
      case "cancel":
        yield { type: "permission_resolved", stepId: stepLabel, approved: false };
        return { kind: "cancelled" };
      case "approve":
      case "raise_cap":
        yield { type: "permission_resolved", stepId: stepLabel, approved: true };
        break;
    }
  }

  // ── Reserve → run → settle ──
  let reservation: ReservationId;
  try {
    reservation = await deps.budget.reserve(deps.workspaceId, estCents, idempotencyKey);
  } catch (err) {
    yield* emitError(err);
    return { kind: "cancelled" };
  }

  yield { type: "tool_call_started", stepId: stepLabel, api, path, estCents };

  const startedAt = Date.now();
  try {
    const runResult = await deps.orthogonal.run({
      api,
      path,
      idempotencyKey,
      ...(body ? { body } : {}),
      ...(query ? { query } : {}),
    });
    const latencyMs = Date.now() - startedAt;

    await deps.budget.settle(reservation, runResult.priceCents);

    const distilled = distill(runResult.data);
    await deps.memory.appendDistilled(deps.conversationId, runResult.requestId, distilled.summary, runResult.data);

    const nextSession = sessionCents + runResult.priceCents;
    const remaining = await deps.budget.remaining(deps.workspaceId);

    yield {
      type: "tool_result",
      stepId: stepLabel,
      requestId: runResult.requestId,
      summary: distilled.summary,
      priceCents: runResult.priceCents,
      latencyMs,
      ok: runResult.success,
    };
    yield {
      type: "cost_update",
      sessionCents: nextSession,
      capCents: decision.sessionCapCents,
      workspaceRemainingCents: remaining,
    };

    const feedback = `${api} ${path} → ${distilled.summary} (requestId: ${runResult.requestId})`;
    return { kind: "ok", sessionCents: nextSession, toolContent: feedback };
  } catch (err) {
    // The call failed: release the hold so we never leak the reservation.
    await deps.budget.refund(reservation).catch(() => undefined);
    if (isOrthaError(err) && err.retryable) {
      // Stub self-heal signal: a richer planner would route to an alternate provider here.
      yield { type: "self_heal", failedProvider: api, altProvider: api };
    }
    yield* emitError(err);
    return { kind: "cancelled" };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function* emitError(err: unknown): AsyncGenerator<TraceEvent, void> {
  if (isOrthaError(err)) {
    yield {
      type: "error",
      code: err.code,
      message: err.message,
      ...(err.providerSlug !== undefined ? { providerSlug: err.providerSlug } : {}),
    };
    return;
  }
  yield {
    type: "error",
    code: ErrorCode.TOOL_UNKNOWN_STATE,
    message: err instanceof Error ? err.message : String(err),
  };
}

function toolMessage(toolCallId: string, toolName: string, content: string): LLMMessage {
  return { role: "tool", content, toolCallId, toolName };
}

async function checkpoint(
  deps: AgentDeps,
  messages: readonly LLMMessage[],
  step: number,
  sessionCents: number,
): Promise<void> {
  await deps.checkpoint({ messages: [...messages], step, sessionCents });
}

function summarizeSearch(query: string, results: readonly ToolApi[]): string {
  if (results.length === 0) return `No tools found for "${query}".`;
  const lines = results.flatMap((api) =>
    api.endpoints.map(
      (ep) => `${api.slug} ${ep.path} [${ep.method}] $${ep.price} — ${ep.description}`,
    ),
  );
  return `Found ${results.length} API(s) for "${query}":\n${lines.join("\n")}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
