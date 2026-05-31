import {
  asIdempotencyKey,
  asRequestId,
  ErrorCode,
  isOrthaError,
  type BudgetPolicy,
  type ConversationId,
  type Endpoint,
  type IdempotencyKey,
  type LLMMessage,
  type LLMProvider,
  type MemoryStore,
  type OrthogonalClient,
  type PermissionResponse,
  type ReservationId,
  type SideEffectClass,
  type ToolApi,
  type ToolSpec,
  type TraceEvent,
  type WebClient,
  type WebPage,
  type WorkspaceId,
} from "@ortha/contracts";
import { distill, requestKey } from "@ortha/harness";
import {
  asRecord,
  asString,
  asStringRecord,
  buildSystemPrompt,
  EXPAND_RESULT,
  GET_TOOL_DETAILS,
  RUN_TOOL,
  SEARCH_TOOLS,
  toolsForTurn,
  WEB_SCRAPE,
  WEB_SEARCH,
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
  /** Always-on general web access (search + read), executed by the agent for every provider. */
  readonly web: WebClient;
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
  readonly onMessage?: (message: LLMMessage, meta?: { readonly priceCents?: number; readonly latencyMs?: number }) => Promise<void> | void;
  /** Hard ceiling on output tokens per LLM turn. Defaults to 1024. */
  readonly maxTokens?: number;
  /** Max tool-using iterations before forcing a stop. Defaults to 8. */
  readonly maxIterations?: number;
  /** Raises the per-turn web_search cap for explicit deep-research turns. */
  readonly deepResearch?: boolean;
  /**
   * Gates the always-on free web tools. Defaults to ON (undefined → true). When
   * explicitly false, web_search/web_scrape are omitted from the tools advertised to
   * the model for this turn (the catalog meta-tools stay), so it cannot search/scrape.
   */
  readonly webSearch?: boolean;
}

export interface AgentInput {
  readonly messages: readonly LLMMessage[];
}

// Output-token ceiling per model call. Must cover BOTH a "thinking" model's hidden
// reasoning tokens AND the visible answer — Gemini 3 counts thinking against max_tokens,
// so a low cap (1024) gets eaten by reasoning on a heavy multi-search turn and the
// answer truncates mid-sentence. Keep this generous so research answers complete.
const DEFAULT_MAX_TOKENS = 8192;
// Tool-using iterations per turn. Kept generous because multi-entity research
// ("find emails for the founders of N companies") is inherently many calls —
// company/people lookup + an email-finder per founder can be 20+ run_tool steps.
// Simple turns stop early on their own (the model answers and ends), and the
// spend cap + permission gates bound cost, so a high ceiling only unblocks the
// hard tasks; it doesn't make easy ones expensive. 32 covers ~15-20 founders
// (a company/people lookup + one or two enrichment calls each) in one turn.
const DEFAULT_MAX_ITERATIONS = 32;
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

/** Per-turn cap on free web_search calls; raised when deep-research mode is requested.
 *  Generous so discovery (find the companies, find each one's people) doesn't exhaust
 *  the budget before the agent runs the catalog endpoints that actually pull the data. */
const WEB_SEARCH_BUDGET = 8;
const WEB_SEARCH_BUDGET_DEEP = 16;

/** Normalize a query so near-identical web searches (case/whitespace) collapse to one. */
function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

// A turn can legitimately reach `done` with no answer tokens and no pending call:
// heavy-search budget exhaustion, or the cold-start first-message race. Rather than
// emit an empty bubble, prompt the model ONCE to synthesize from what it has.
const SYNTHESIZE_NUDGE =
  "Answer now using what you already have from this turn. Give your best complete answer in plain language; do not call any more tools.";
const BLANK_FALLBACK =
  "I wasn't able to put together an answer for that just now. Could you rephrase or narrow the question?";

interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  /** Opaque provider metadata to replay verbatim (e.g. Gemini 3 thought_signature). */
  readonly extra?: unknown;
}

/** What get_tool_details recorded about an endpoint, used to gate the later run. */
interface EndpointInfo {
  readonly sideEffect: SideEffectClass;
  readonly longRunning: boolean;
}

/** Per-turn free-web-search accounting: call budget + dedup of normalized queries. */
interface WebSearchBudget {
  used: number;
  readonly cap: number;
  readonly seen: Set<string>;
}

/**
 * The portable orchestration loop. A pure async generator driven entirely by the
 * injected ports — no Cloudflare, no Durable Object coupling. Yields the TraceEvent
 * union; the transport layer relays these over the wire.
 */
export async function* runAgentTurn(deps: AgentDeps, input: AgentInput): AsyncIterable<TraceEvent> {
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxIterations = deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  // Tools advertised this turn: drops the free web tools when web access is gated off.
  const tools = toolsForTurn(deps.webSearch);

  const messages: LLMMessage[] = [...input.messages];
  let sessionCents = 0;
  let stepCounter = 0;
  let autoContinues = 0;
  // True once ANY assistant token was streamed this turn. Drives the blank-turn
  // guard: a turn that reaches `done` having emitted nothing gets one synthesis retry.
  let emittedAnyToken = false;
  // Per-turn free-web-search accounting: a call budget plus a dedup set of normalized
  // queries, so a model can't burn the turn re-running the same/near-identical search.
  const webSearch: WebSearchBudget = {
    used: 0,
    cap: deps.deepResearch ? WEB_SEARCH_BUDGET_DEEP : WEB_SEARCH_BUDGET,
    seen: new Set<string>(),
  };
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
      //    Build the prompt per turn so today's injected date never goes stale.
      for await (const event of deps.llm.streamCompletion({
        model: deps.model,
        system: buildSystemPrompt(new Date()),
        messages,
        tools,
        maxTokens,
      })) {
        switch (event.type) {
          case "token":
            assistantText += event.text;
            if (event.text.length > 0) emittedAnyToken = true;
            yield { type: "token", text: event.text };
            break;
          case "tool_call_request":
            pending.push({ id: event.id, name: event.name, args: event.args, ...(event.extra !== undefined ? { extra: event.extra } : {}) });
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
        const toolCalls = pending.map((p) => ({ id: p.id, name: p.name, args: p.args, ...(p.extra !== undefined ? { extra: p.extra } : {}) }));
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
        // Blank-turn guard: the model is done but emitted no answer text anywhere this
        // turn (budget exhaustion or cold-start race). Stream a single synthesis retry
        // rather than ending on an empty bubble — capped at one attempt below.
        if (!emittedAnyToken) {
          await checkpoint(deps, messages, ++stepCounter, sessionCents);
          yield* synthesizeBlankTurn(deps, messages, maxTokens, tools);
          await checkpoint(deps, messages, ++stepCounter, sessionCents);
          yield { type: "done", stopReason: "end" };
          return;
        }
        await checkpoint(deps, messages, ++stepCounter, sessionCents);
        yield { type: "done", stopReason: streamStopReason === "max_tokens" ? "max_tokens" : "end" };
        return;
      }

      // ── 3. Dispatch each requested tool call. ──
      for (const call of pending) {
        const result = yield* dispatch(deps, call, ++stepCounter, sessionCents, sideEffects, webSearch);
        if (result.kind === "cancelled") {
          await checkpoint(deps, messages, stepCounter, sessionCents);
          yield { type: "done", stopReason: "end" };
          return;
        }
        sessionCents = result.sessionCents;
        const toolMsg = toolMessage(call.id, call.name, result.toolContent);
        messages.push(toolMsg);
        await deps.onMessage?.(toolMsg, {
          ...(result.priceCents !== undefined ? { priceCents: result.priceCents } : {}),
          ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
        });
      }

      await checkpoint(deps, messages, stepCounter, sessionCents);
    }

    // ── 4. Hit the iteration cap without a final answer. If nothing was ever
    //       streamed, give one synthesis retry so the user still gets an answer. ──
    if (!emittedAnyToken) {
      yield* synthesizeBlankTurn(deps, messages, maxTokens, tools);
      await checkpoint(deps, messages, ++stepCounter, sessionCents);
    }
    yield { type: "done", stopReason: "max_tokens" };
  } catch (err) {
    yield* emitError(err);
  }
}

/**
 * One-shot blank-turn recovery: re-prompt the model to answer from what it already
 * gathered this turn (no further tools), stream that, and if it STILL emits nothing,
 * stream a short honest fallback. Capped at this single attempt — never loops.
 */
async function* synthesizeBlankTurn(
  deps: AgentDeps,
  messages: LLMMessage[],
  maxTokens: number,
  tools: readonly ToolSpec[],
): AsyncGenerator<TraceEvent, void> {
  // Ephemeral nudge: not persisted via onMessage, so it stays out of the transcript.
  const prompted: LLMMessage[] = [...messages, { role: "user", content: SYNTHESIZE_NUDGE }];
  let text = "";
  try {
    for await (const event of deps.llm.streamCompletion({
      model: deps.model,
      system: buildSystemPrompt(new Date()),
      messages: prompted,
      tools,
      maxTokens,
    })) {
      if (event.type === "token") {
        text += event.text;
        if (event.text.length > 0) yield { type: "token", text: event.text };
      }
    }
  } catch {
    // Fall through to the static fallback below.
  }
  if (text.trim().length === 0) {
    text = BLANK_FALLBACK;
    yield { type: "token", text };
  }
  const msg: LLMMessage = { role: "assistant", content: text };
  messages.push(msg);
  await deps.onMessage?.(msg);
}

// ── Tool dispatch ────────────────────────────────────────────────────────────

type DispatchResult =
  | {
      readonly kind: "ok";
      readonly sessionCents: number;
      readonly toolContent: string;
      // Set for tool calls that produce a trace block (run_tool, web_*) so the transport
      // can persist them on the tool message — letting a reopened conversation show the
      // same price + latency the live trace did. Undefined for meta tools (no block).
      readonly priceCents?: number;
      readonly latencyMs?: number;
    }
  | { readonly kind: "cancelled" };

async function* dispatch(
  deps: AgentDeps,
  call: ToolCallRequest,
  stepId: number,
  sessionCents: number,
  sideEffects: Map<string, EndpointInfo>,
  webSearch: WebSearchBudget,
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
    case WEB_SEARCH:
      return yield* dispatchWebSearch(deps, call, stepId, sessionCents, webSearch);
    case WEB_SCRAPE:
      return yield* dispatchWebScrape(deps, call, stepId, sessionCents);
    default:
      return { kind: "ok", sessionCents, toolContent: `Unknown tool "${call.name}".` };
  }
}

async function* dispatchSearch(
  deps: AgentDeps,
  call: ToolCallRequest,
  sessionCents: number,
): AsyncGenerator<TraceEvent, DispatchResult> {
  const query = asString(call.args["query"])?.trim() ?? "";
  // Empty query would 400 the catalog ("Search prompt is required"); feed that back
  // instead of letting it abort the whole turn (mirrors web_search's guard).
  if (!query) {
    return { kind: "ok", sessionCents, toolContent: "search_tools requires a non-empty 'query' describing the capability you need (e.g. \"find work email by name and company\")." };
  }
  let results;
  try {
    results = await deps.orthogonal.search({ prompt: query });
  } catch (err) {
    // A catalog hiccup (400/timeout) must NOT kill the turn — surface it so the model
    // can rephrase, try the web tools, or answer with what it already has.
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "ok", sessionCents, toolContent: `search_tools failed for "${query}": ${message}. Try a different phrasing, the web tools, or answer with what you already have.` };
  }
  // Surface the matched endpoints (ranked, recommended first) in the trace so the chat
  // can show WHICH tools were found, not just the count. Capped to keep the event small.
  const tools = rankEndpoints(results).slice(0, 12).map(({ api, ep }) => `${api.slug} ${ep.path}`);
  yield { type: "tool_search", query, resultCount: results.length, tools };
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
  let details;
  try {
    details = await deps.orthogonal.getDetails(api, path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "ok", sessionCents, toolContent: `get_tool_details failed for ${api} ${path}: ${message}. Pick a different endpoint from your search_tools results.` };
  }
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

/** Emit a failed web step + feed the error back so the turn keeps going (free tools). */
function* webFailed(stepLabel: string, tool: string, startedAt: number, err: unknown, sessionCents: number): Generator<TraceEvent, DispatchResult> {
  const message = err instanceof Error ? err.message : String(err);
  const latencyMs = Date.now() - startedAt;
  yield {
    type: "tool_result",
    stepId: stepLabel,
    requestId: asRequestId(`web_${stepLabel}`),
    summary: `failed — ${message}`,
    priceCents: 0,
    latencyMs,
    ok: false,
  };
  return { kind: "ok", sessionCents, toolContent: `${tool} failed: ${message}. Try a different query/URL, or answer with what you already have.`, priceCents: 0, latencyMs };
}

async function* dispatchWebSearch(
  deps: AgentDeps,
  call: ToolCallRequest,
  stepId: number,
  sessionCents: number,
  webSearch: WebSearchBudget,
): AsyncGenerator<TraceEvent, DispatchResult> {
  const query = asString(call.args["query"]) ?? "";
  const stepLabel = `step_${stepId}`;
  if (!query.trim()) return { kind: "ok", sessionCents, toolContent: "web_search requires a non-empty query." };

  // Dedup near-identical queries: a repeated search yields no new info and burns the
  // turn. Short-circuit (no network, no step) and point the model at earlier results.
  const norm = normalizeQuery(query);
  if (webSearch.seen.has(norm)) {
    return { kind: "ok", sessionCents, toolContent: "Already searched that — use the earlier results." };
  }
  // Per-turn budget: once spent, steer to the catalog (still available) rather than
  // stopping. The model used to read "budget reached" as overall capacity and quit early.
  if (webSearch.used >= webSearch.cap) {
    return {
      kind: "ok",
      sessionCents,
      toolContent:
        "Web-search budget reached for this turn. This does NOT limit the catalog — keep using search_tools / run_tool for any structured data you still need (people, contacts, emails, enrichment), including finishing per-entity lookups. Only answer once you've gathered what the user asked for.",
    };
  }
  webSearch.used += 1;
  webSearch.seen.add(norm);

  yield { type: "tool_call_started", stepId: stepLabel, api: "web", path: `search: "${query}"`, estCents: 0 };
  const startedAt = Date.now();
  try {
    const results = await deps.web.search(query);
    yield {
      type: "tool_result",
      stepId: stepLabel,
      requestId: asRequestId(`web_${stepLabel}`),
      summary: `${results.length} web result${results.length === 1 ? "" : "s"} for "${query}"`,
      priceCents: 0,
      latencyMs: Date.now() - startedAt,
      ok: results.length > 0,
    };
    const body =
      results.length === 0
        ? `No web results for "${query}".`
        : results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n");
    return { kind: "ok", sessionCents, toolContent: body, priceCents: 0, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return yield* webFailed(stepLabel, "web_search", startedAt, err, sessionCents);
  }
}

/** Markdown for one fetched page, with a source header. */
function pageSection(page: WebPage): string {
  const header = page.title ? `# ${page.title}\n(source: ${page.url})` : `(source: ${page.url})`;
  return `${header}\n\n${page.markdown}`;
}

async function* dispatchWebScrape(
  deps: AgentDeps,
  call: ToolCallRequest,
  stepId: number,
  sessionCents: number,
): AsyncGenerator<TraceEvent, DispatchResult> {
  const single = asString(call.args["url"]);
  const many = Array.isArray(call.args["urls"])
    ? (call.args["urls"] as unknown[]).filter((u): u is string => typeof u === "string" && u.trim().length > 0)
    : [];
  // De-dup, preserve order; a lone `url` is just a one-element batch.
  const urls = [...new Set([...(single && single.trim() ? [single] : []), ...many])];
  const stepLabel = `step_${stepId}`;
  if (urls.length === 0) {
    return { kind: "ok", sessionCents, toolContent: "web_scrape requires a 'url' or a non-empty 'urls' array." };
  }

  // Single page: one tool_call_started + one tool_result, as before.
  if (urls.length === 1) {
    const url = urls[0]!;
    yield { type: "tool_call_started", stepId: stepLabel, api: "web", path: url, estCents: 0 };
    const startedAt = Date.now();
    try {
      const page = await deps.web.scrape(url);
      yield {
        type: "tool_result",
        stepId: stepLabel,
        requestId: asRequestId(`web_${stepLabel}`),
        summary: `read ${page.url} (${page.markdown.length} chars${page.truncated ? ", truncated" : ""})`,
        priceCents: 0,
        latencyMs: Date.now() - startedAt,
        ok: true,
      };
      return { kind: "ok", sessionCents, toolContent: pageSection(page), priceCents: 0, latencyMs: Date.now() - startedAt };
    } catch (err) {
      return yield* webFailed(stepLabel, "web_scrape", startedAt, err, sessionCents);
    }
  }

  // Multiple pages: fetch concurrently (bounded fan-out in the web client) so a
  // research turn reads N pages in one round-trip of latency, not N.
  yield { type: "tool_call_started", stepId: stepLabel, api: "web", path: `scrape ${urls.length} pages`, estCents: 0 };
  const startedAt = Date.now();
  try {
    const settled = await deps.web.scrapeMany(urls);
    const okCount = settled.filter((s) => s.status === "fulfilled").length;
    yield {
      type: "tool_result",
      stepId: stepLabel,
      requestId: asRequestId(`web_${stepLabel}`),
      summary: `read ${okCount}/${urls.length} pages`,
      priceCents: 0,
      latencyMs: Date.now() - startedAt,
      ok: okCount > 0,
    };
    const sections = settled.map((s, i) => {
      if (s.status === "fulfilled") return pageSection(s.value);
      const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
      return `(failed to read ${urls[i]}: ${reason})`;
    });
    return { kind: "ok", sessionCents, toolContent: sections.join("\n\n---\n\n"), priceCents: 0, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return yield* webFailed(stepLabel, "web_scrape", startedAt, err, sessionCents);
  }
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
  // A dynamic price means estCents is a FLOOR, not the exact charge. We do NOT gate on
  // that alone — a cheap dynamic call (e.g. 1¢ when the per-call warn is 25¢) shouldn't
  // nag. A dynamic call gates only when its floor estimate crosses the per-call-warn or
  // session cap like any other call; we just flag "price varies" on the chip when it does.
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

  if (decision.decision === "permission_required" || isWrite) {
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

    // Echo the inputs actually sent so the model can self-check result-vs-request
    // (did the returned entity match the email/name/domain it asked for?).
    const compactInputs = compactJson({ ...(body ? { body } : {}), ...(query ? { query } : {}) });
    const feedback = `run_tool ${api} ${path} ${compactInputs} → ${distilled.summary} (requestId: ${runResult.requestId})`;
    return { kind: "ok", sessionCents: nextSession, toolContent: feedback, priceCents: runResult.priceCents, latencyMs };
  } catch (err) {
    // The call failed: release the hold so we never leak the reservation.
    await deps.budget.refund(reservation).catch(() => undefined);
    const latencyMs = Date.now() - startedAt;
    if (isOrthaError(err) && err.retryable) {
      // Stub self-heal signal: a richer planner would route to an alternate provider here.
      yield { type: "self_heal", failedProvider: api, altProvider: api };
    }
    // A single failed tool call must NOT abort the whole turn. Surface it as a
    // failed step in the trace and feed the error back to the model so it can try
    // a different tool or answer with what it already has — instead of ending with
    // an empty/incomplete reply (issue #16).
    const code = isOrthaError(err) ? err.code : ErrorCode.TOOL_UNKNOWN_STATE;
    const message = err instanceof Error ? err.message : String(err);
    yield {
      type: "tool_result",
      stepId: stepLabel,
      requestId: asRequestId(`failed_${stepLabel}`),
      summary: `failed — ${code}: ${message}`,
      priceCents: 0,
      latencyMs,
      ok: false,
    };
    return {
      kind: "ok",
      sessionCents,
      toolContent: `${api} ${path} failed (${code}: ${message}). Do not retry the same call — try a different tool, or answer with what you already have.`,
      priceCents: 0,
      latencyMs,
    };
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

/** Flatten every endpoint with its parent api, ranked DETERMINISTICALLY (verified desc,
 *  score desc, price asc) so repeated searches route to the same top endpoint. Shared by
 *  the model-facing summary and the trace's tool list. */
function rankEndpoints(results: readonly ToolApi[]): { api: ToolApi; ep: Endpoint }[] {
  const flat = results.flatMap((api) => api.endpoints.map((ep: Endpoint) => ({ api, ep })));
  flat.sort((a, b) => {
    const v = Number(b.ep.verified ?? false) - Number(a.ep.verified ?? false);
    if (v !== 0) return v;
    const s = (b.ep.score ?? 0) - (a.ep.score ?? 0);
    if (s !== 0) return s;
    return endpointPrice(a.ep) - endpointPrice(b.ep);
  });
  return flat;
}

function summarizeSearch(query: string, results: readonly ToolApi[]): string {
  if (results.length === 0) return `No tools found for "${query}".`;
  // The top entry is tagged "(recommended)" so the model picks it consistently.
  const flat = rankEndpoints(results);
  const lines = flat.map(({ api, ep }, i) => {
    const price = ep.price !== undefined ? `$${ep.price}` : "$?";
    const tags = [ep.verified ? "verified" : undefined, i === 0 ? "(recommended)" : undefined]
      .filter(Boolean)
      .join(" ");
    return `${api.slug} ${ep.path} [${ep.method}] ${price} — ${ep.description}${tags ? ` ${tags}` : ""}`;
  });
  return `Found ${results.length} API(s) for "${query}":\n${lines.join("\n")}`;
}

/** A sortable numeric price; endpoints without one rank last (treated as +∞). */
function endpointPrice(ep: Endpoint): number {
  if (ep.price === undefined) return Number.POSITIVE_INFINITY;
  const n = Number.parseFloat(ep.price);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Short JSON for echoing run_tool inputs back to the model; truncated to stay compact. */
function compactJson(value: Record<string, unknown>, max = 200): string {
  const s = safeJson(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
