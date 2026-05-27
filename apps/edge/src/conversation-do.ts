import { runAgentTurn, type AgentDeps } from "@ortha/agent";
import {
  asConversationId,
  asWorkspaceId,
  type ConversationId,
  type LLMMessage,
  type PermissionResponse,
  type WorkspaceId,
} from "@ortha/contracts";
import { applySchema, createStore, d1Adapter, DEFAULT_SETTINGS, type SqlDb } from "@ortha/db";
import type { ConversationStore } from "@ortha/contracts";
import { doSqlAdapter } from "./do-sql.js";
import type { Env } from "./env.js";
import {
  ECHO_GUARD_PREFIX_CHARS,
  EMPTY_INPUT_MESSAGE,
  getSystemPromptText,
  isBlankInput,
  isSystemPromptEcho,
  SYSTEM_PROMPT_REFUSAL,
} from "./guards.js";
import { reconstructHistory } from "./history.js";
import { buildLivePorts } from "./ports.js";
import { createSqlRawStore, RAW_BLOBS_DDL } from "./raw-store.js";
import { DurableSpendStore, SESSION_SPEND_DDL, WORKSPACE_SPEND_DDL } from "./spend-store.js";
import { kvSessionStore } from "./auth-stores.js";
import { generateTitle } from "./titles.js";

const DEMO_WS: WorkspaceId = asWorkspaceId("demo-ws");
const HISTORY_BUDGET_TOKENS = 8_000;

/**
 * Conversation Durable Object — one instance per conversation id.
 *
 * Wires the portable @ortha/agent loop to the edge: native WebSocket streaming of
 * TraceEvents, the DO's own synchronous SQLite as the source-of-truth store
 * (@ortha/db), per-step checkpoint, and an inline permission gate relayed over WS.
 * Turns are serialized (one in-flight per DO). Demo ports drive the real loop with
 * mocks; live ports (BYOK) slot in where noted.
 */
export class ConversationDO implements DurableObject {
  private readonly db: SqlDb;
  private readonly store: ConversationStore;
  // Keyed by the NAME the client addresses (the URL path segment), set in fetch(),
  // so a conversation can be re-opened via idFromName(name). ctx.id is the fallback.
  private conversationId: ConversationId;
  private initialized = false;
  private running = false;
  private workspaceId: WorkspaceId = DEMO_WS;
  private deviceId: string | null = null;
  private pendingPermission: ((r: PermissionResponse) => void) | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.db = doSqlAdapter(ctx.storage.sql);
    this.store = createStore(this.db);
    this.conversationId = asConversationId(ctx.id.toString());
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Identity comes from the session token (browsers can't set Authorization on a
    // WebSocket, so it travels as ?token=). Keys are device-scoped via ?device=.
    const token = url.searchParams.get("token");
    const session = token ? await kvSessionStore(this.env.KV).get(token) : null;
    const valid = session && session.expiresAt > Date.now() ? session : null;
    if (valid) this.workspaceId = valid.workspaceId;
    const deviceParam = url.searchParams.get("device");
    if (deviceParam && /^[a-zA-Z0-9_-]{6,64}$/.test(deviceParam)) this.deviceId = deviceParam;
    // The client addresses this DO via idFromName(<path-name>); key storage + the KV
    // index by that same name so the conversation is re-openable. Falls back to ctx.id.
    const nameMatch = url.pathname.match(/\/conversations\/([^/]+)\//);
    if (nameMatch?.[1]) this.conversationId = asConversationId(decodeURIComponent(nameMatch[1]));
    if (request.headers.get("Upgrade") !== "websocket") {
      // Internal delete signal from the Worker (`DELETE /api/conversations/:id`):
      // wipe this conversation's stored messages. Authorization happened in the
      // Worker (validated session + workspace); this DO is addressed only by id, so
      // there's no per-message workspace check to do here: the whole DO is the
      // conversation. Best-effort: errors are swallowed, the KV index removal is
      // what makes the conversation disappear from the sidebar.
      if (request.method === "POST" && url.searchParams.get("action") === "delete") {
        await this.clearStoredData().catch(() => {});
        return Response.json({ ok: true });
      }
      // "Open raw" panel: GET .../raw/:requestId returns the full out-of-context tool
      // payload this conversation stored (the same blob `expand_result` reads). Auth
      // already happened in the Worker, which forwards only after validating the session.
      const rawMatch = url.pathname.match(/\/raw\/([^/]+)$/);
      if (request.method === "GET" && rawMatch) {
        await this.init();
        const requestId = decodeURIComponent(rawMatch[1]!);
        const data = await createSqlRawStore(this.db).get(requestId);
        if (data === null || data === undefined) return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json({ requestId, raw: data });
      }
      return Response.json({ ok: true, durableObject: "ConversationDO", id: this.ctx.id.toString() });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.handleSession(server, valid !== null);
    return new Response(null, { status: 101, webSocket: client });
  }

  private handleSession(ws: WebSocket, authed: boolean): void {
    ws.accept();
    if (!authed) {
      ws.send(JSON.stringify({ type: "error", code: "AUTH", message: "Your session expired — sign in again to continue." }));
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      return;
    }
    void this.sendHistory(ws);
    ws.addEventListener("message", (ev) => void this.onMessage(ws, ev));
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      applySchema(this.db);
      // DO-local per-conversation session spend (accumulates across turns).
      this.db.run(SESSION_SPEND_DDL);
      // DO-local durable, size-capped raw tool-result blobs (cross-turn expand_result).
      this.db.run(RAW_BLOBS_DDL);
      // D1 cross-conversation workspace monthly spend.
      await d1Adapter(this.env.DB).run(WORKSPACE_SPEND_DDL);
    });
    this.initialized = true;
  }

  private async sendHistory(ws: WebSocket): Promise<void> {
    await this.init();
    const msgs = await this.store.loadWindow(this.conversationId, HISTORY_BUDGET_TOKENS);
    // The transcript stores tool-call plumbing (assistant tool-call turns + tool
    // results) alongside the real chat turns. Reconstruct the per-turn agent-trace
    // blocks from that plumbing so a re-opened conversation shows the collapsible
    // tool-call lines (api · path · status, with the requestId for "Open raw") just
    // as they appeared live — not only the plain user/assistant text.
    const messages = reconstructHistory(msgs);
    ws.send(JSON.stringify({ type: "history", messages }));
  }

  private async onMessage(ws: WebSocket, ev: MessageEvent): Promise<void> {
    let msg: {
      type?: string;
      text?: string;
      images?: unknown;
      deepResearch?: unknown;
      webSearch?: unknown;
      response?: PermissionResponse;
    };
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "{}");
    } catch {
      return;
    }
    if (msg.type === "permission" && msg.response && this.pendingPermission) {
      this.pendingPermission(msg.response);
      this.pendingPermission = null;
      return;
    }
    if (msg.type !== "user_message" || typeof msg.text !== "string") return;
    if (this.running) {
      ws.send(JSON.stringify({ type: "error", code: "BAD_REQUEST", message: "a turn is already running" }));
      return;
    }
    const images = sanitizeImages(msg.images);
    // Empty/whitespace-only input guard: reject cleanly before starting a turn so we
    // never burn an iteration (or any spend) on "". Images are valid input on their
    // own, so a blank-text message that carries images still proceeds.
    if (isBlankInput(msg.text, images.length)) {
      ws.send(JSON.stringify({ type: "error", code: "BAD_REQUEST", message: EMPTY_INPUT_MESSAGE }));
      return;
    }
    // The composer's web-search toggle defaults ON: only an explicit `false` disables
    // it. Missing/undefined (older clients) stays ON. Mirrors how deepResearch threads.
    const webSearch = msg.webSearch !== false;
    this.running = true;
    try {
      await this.runTurn(ws, msg.text, images, msg.deepResearch === true, webSearch);
    } finally {
      this.running = false;
    }
  }

  /**
   * Upsert this conversation into the per-workspace index (KV) so the sidebar can list
   * it. The provisional first-prompt title is set once and never clobbered by a later
   * turn — except when `force` is set, which is how the async LLM-summarized title
   * (see `generateTitle`) replaces the placeholder once it's ready.
   */
  private async registerConversation(title: string, force = false): Promise<void> {
    const key = `conv-index:${this.workspaceId}`;
    let list: { id: string; title: string; updatedAt: number }[] = [];
    try {
      const raw = await this.env.KV.get(key);
      if (raw) list = JSON.parse(raw) as typeof list;
    } catch {
      /* start fresh */
    }
    const id = this.conversationId as string;
    const existing = list.find((c) => c.id === id);
    if (existing) {
      // A forced title update (the LLM summary) shouldn't bump the conversation to the
      // top of the list — it lands shortly after the turn and isn't new activity.
      if (force) {
        if (title) existing.title = title;
      } else {
        existing.updatedAt = Date.now();
        if (!existing.title) existing.title = title;
      }
    } else {
      list.unshift({ id, title, updatedAt: Date.now() });
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    if (list.length > 50) list = list.slice(0, 50);
    await this.env.KV.put(key, JSON.stringify(list));
  }

  /**
   * Wipe every row this conversation owns from the DO's SQLite. One DO instance maps
   * to exactly one conversation, so clearing these tables removes all of its data:
   * the chat transcript (messages), tool-call plumbing, the write-once journal,
   * context summaries, and the cross-turn raw-result blobs. Idempotent: running it
   * against an empty/never-initialized DO is a no-op.
   */
  private async clearStoredData(): Promise<void> {
    await this.init();
    for (const table of ["messages", "tool_calls", "call_journal", "summaries", "raw_blobs"]) {
      try {
        this.db.run(`DELETE FROM ${table}`);
      } catch {
        /* table may not exist yet; ignore */
      }
    }
  }

  /** Read the workspace's monthly cap from KV settings (same key buildLivePorts uses). */
  private async resolveMonthlyCapCents(): Promise<number> {
    try {
      const raw = await this.env.KV.get(`settings:${this.workspaceId}`);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<{ monthlyCapCents: number }>;
        if (typeof parsed.monthlyCapCents === "number") return parsed.monthlyCapCents;
      }
    } catch {
      /* fall through to default */
    }
    return DEFAULT_SETTINGS.monthlyCapCents;
  }

  private async runTurn(
    ws: WebSocket,
    text: string,
    images: readonly string[] = [],
    deepResearch = false,
    webSearch = true,
  ): Promise<void> {
    await this.init();
    // First message of a conversation? Decide BEFORE appending this turn's user
    // message: an empty window means there's no prior history, so this is the prompt
    // we summarize into the sidebar title. (Checked here so we don't count the message
    // we're about to append.)
    const prior = await this.store.loadWindow(this.conversationId, HISTORY_BUDGET_TOKENS);
    const isFirstMessage = prior.length === 0;
    await this.store.appendMessage({ conversationId: this.conversationId, role: "user", content: text });
    // Set a provisional truncated title immediately so the chat appears in the sidebar
    // right away; the LLM-summarized title (below) replaces it shortly after.
    await this.registerConversation(text.slice(0, 60)).catch(() => {});

    const history = await this.store.loadWindow(this.conversationId, HISTORY_BUDGET_TOKENS);
    // Rehydrate the full transcript (incl. tool calls + results with requestIds) so the
    // model can expand_result a prior turn's call. Start at the first user message so the
    // window never opens on an orphan tool result whose assistant tool_call was trimmed.
    const rehydrated: LLMMessage[] = history.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
      ...(m.toolName ? { toolName: m.toolName } : {}),
    }));
    const messages: LLMMessage[] = sanitizeTranscript(rehydrated);
    // Attach this turn's images to its (last) user message so a vision-capable model
    // can analyze them. Images aren't persisted in the transcript store (they'd bloat
    // it), so they live only on the in-memory message for this turn.
    if (images.length > 0) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === "user") {
          messages[i] = { ...messages[i]!, images };
          break;
        }
      }
    }

    // Durable spend store: workspace monthly spend in D1, session spend in this DO's
    // SQLite. Seeded with the workspace's monthly cap so `remaining()` is correct.
    const monthlyCapCents = await this.resolveMonthlyCapCents();
    const spendStore = new DurableSpendStore({
      d1: d1Adapter(this.env.DB),
      doSql: this.db,
      monthlyCapCents,
    });
    // Durable, size-capped raw-result store backed by this DO's SQLite, so raw tool
    // results survive across turns (expand_result) and oversized blobs are truncated.
    const rawStore = createSqlRawStore(this.db);

    // Real ports from the workspace's BYOK keys. No keys configured → surface a
    // clear error and stop. We never run a fake/demo turn — real users, real spend.
    const ports = await buildLivePorts(this.env, this.workspaceId, this.deviceId, spendStore, rawStore).catch(() => null);
    if (!ports) {
      ws.send(
        JSON.stringify({
          type: "error",
          code: "AUTH",
          message: "No API keys configured. Add your Orthogonal key and a model-provider key in Settings to start.",
        }),
      );
      return;
    }

    // On the first message, summarize the prompt into a short sidebar title via a
    // cheap LLM call. Run it WITHOUT blocking the user's answer: hand it to
    // `ctx.waitUntil` so the DO stays alive until it finishes, while the streamed
    // turn below proceeds immediately. The provisional truncated title is already in
    // the index, so a failure here just leaves that in place (and `generateTitle`
    // itself falls back to the truncated prompt on error).
    if (isFirstMessage) {
      const llm = ports.llm;
      const model = ports.model;
      this.ctx.waitUntil(
        generateTitle(llm, model, text)
          .then((title) => this.registerConversation(title, true))
          .catch(() => {}),
      );
    }

    const deps: AgentDeps = {
      llm: ports.llm,
      orthogonal: ports.orthogonal,
      web: ports.web,
      budget: ports.budget,
      memory: ports.memory,
      model: ports.model,
      workspaceId: this.workspaceId,
      conversationId: this.conversationId,
      // Deep-research mode (from the composer toggle) raises the per-turn web_search
      // budget in the loop (4 → 8) so a multi-source research turn isn't starved.
      deepResearch,
      // Web-search toggle (composer, default ON). Threaded from the user_message so the
      // loop can suppress general web search when the user turns it off. NOTE: a sibling
      // change adds `webSearch?: boolean` to AgentDeps in @ortha/agent; in this isolated
      // worktree that field may not exist yet, so this is set via a post-construction
      // assignment to avoid an excess-property error on the object literal. Reconciled
      // at merge once the field lands on the type.
      // The gate event is already streamed to the client by the loop's `yield`
      // (relayed in the for-await below); here we only register the resolver and
      // await the client's reply. Re-sending it would double-render the chip.
      requestPermission: () =>
        new Promise<PermissionResponse>((resolve) => {
          this.pendingPermission = resolve;
        }),
      checkpoint: async (state) => {
        await this.ctx.storage.put("step", state.step);
      },
      // Persist the full turn transcript as the loop produces it (assistant tool-call
      // turns + tool results, then the final answer). This is what makes cross-turn
      // expand_result reachable: a later turn reloads the requestId-bearing tool
      // messages. The user message was already persisted above.
      onMessage: async (m) => {
        // Mirror the streamed echo guard into the persisted transcript: if a final
        // assistant answer is a verbatim system-prompt dump, store the refusal instead
        // of the leak, so a later history reload can't re-serve it. Only plain
        // assistant text (no tool calls) is rewritten — a tool-call turn is plumbing
        // the model needs intact for cross-turn expand_result.
        const content =
          m.role === "assistant" && !m.toolCalls && isSystemPromptEcho(m.content, getSystemPromptText())
            ? SYSTEM_PROMPT_REFUSAL
            : m.content;
        await this.store.appendMessage({
          conversationId: this.conversationId,
          role: m.role,
          content,
          ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
          ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
          ...(m.toolName ? { toolName: m.toolName } : {}),
        });
      },
    };
    // Thread the composer's web-search toggle through. Assigned after construction (not
    // in the literal) because `webSearch?: boolean` is a sibling addition to AgentDeps
    // that may not be on the type in this worktree; the cast lets it compile either way
    // and the loop reads the field once the sibling change lands.
    (deps as AgentDeps & { webSearch?: boolean }).webSearch = webSearch;

    // Verbatim system-prompt echo guard (defense-in-depth vs. prompt-injection leaks).
    // Primary defense is the model's own confidentiality rule (in the system prompt);
    // this is the backup that catches a non-compliant dump. We can't un-send a token once
    // it's on the wire, so to be able to REPLACE a leak we buffer only the START of each
    // contiguous text run (ECHO_GUARD_PREFIX_CHARS), check that prefix once, then — if it
    // clears — stream the REST of the run LIVE token-by-token. Extraction attacks dump the
    // prompt from char 0, so the prefix catches them while keeping the GPT/Claude streaming
    // feel for normal answers. Tool-trace events are never buffered. A leak placed AFTER the
    // prefix would stream un-redacted, but that's implausible for extraction and the prompt
    // rule still applies; the persisted-message check above redacts stored content in full.
    const systemPrompt = getSystemPromptText();
    let pendingTokens: string[] = [];
    let pendingText = "";
    let runDecided = false; // prefix cleared → stream the rest of this run live
    let runLeaked = false; // prefix tripped → suppress the rest of this run

    const passPrefix = (): void => {
      for (const text of pendingTokens) ws.send(JSON.stringify({ type: "token", text }));
      pendingTokens = [];
      pendingText = "";
      runDecided = true;
    };
    const tripPrefix = (): void => {
      ws.send(JSON.stringify({ type: "token", text: SYSTEM_PROMPT_REFUSAL }));
      pendingTokens = [];
      pendingText = "";
      runLeaked = true;
    };
    // Close a text run at a boundary (non-token event / done). A short run that never
    // reached the prefix-check length is checked here in full, then flushed or refused.
    const finalizeTextRun = (): void => {
      if (!runDecided && !runLeaked && pendingTokens.length > 0) {
        if (isSystemPromptEcho(pendingText, systemPrompt)) tripPrefix();
        else passPrefix();
      }
      pendingTokens = [];
      pendingText = "";
      runDecided = false;
      runLeaked = false;
    };

    try {
      for await (const event of runAgentTurn(deps, { messages })) {
        if (event.type === "token") {
          if (runLeaked) continue; // suppress the remainder of a leaked run
          if (runDecided) {
            ws.send(JSON.stringify(event)); // prefix cleared — stream live
            continue;
          }
          pendingTokens.push(event.text);
          pendingText += event.text;
          if (pendingText.length >= ECHO_GUARD_PREFIX_CHARS) {
            if (isSystemPromptEcho(pendingText, systemPrompt)) tripPrefix();
            else passPrefix();
          }
          continue;
        }
        // Any non-token event closes the current text run before the boundary event.
        finalizeTextRun();
        ws.send(JSON.stringify(event));
      }
      // The loop always ends with a `done` event (which finalized above); this covers a
      // defensive stream that ends on a trailing token run with no terminator.
      finalizeTextRun();
    } catch (e) {
      finalizeTextRun();
      ws.send(JSON.stringify({ type: "error", code: "PROVIDER_DOWN", message: e instanceof Error ? e.message : "loop error" }));
    }
  }
}

/**
 * Make a rehydrated transcript safe to replay to any provider. The window can open
 * mid-turn (token budget trimmed older messages) or end on a turn that was cancelled
 * mid-dispatch, either of which leaves an orphan: a tool result with no declaring
 * assistant tool_call, or an assistant tool_call with no result. Both are rejected
 * by OpenAI and Anthropic. We keep only matched assistant↔tool pairs.
 */
/** Per-image data-URL byte cap (~4MB of base64). Bounds DO memory + provider payload. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** At most this many images per message. */
const MAX_IMAGES = 2;

/**
 * Validate + bound the optional `images` array from an incoming user_message.
 * Accepts only data URLs (`data:image/...;base64,...`) or http(s) URLs, caps the
 * count, and drops oversized data URLs. A non-array (or absent) value yields [].
 */
function sanitizeImages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const isData = /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(v);
    const isHttp = /^https?:\/\//.test(v);
    if (!isData && !isHttp) continue;
    if (isData && v.length > MAX_IMAGE_BYTES) continue;
    out.push(v);
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

function sanitizeTranscript(msgs: readonly LLMMessage[]): LLMMessage[] {
  const firstUser = msgs.findIndex((m) => m.role === "user");
  const window = firstUser > 0 ? msgs.slice(firstUser) : msgs;
  // A tool_call is replayable only if a tool result for its id exists in the window.
  const answered = new Set(
    window.filter((m) => m.role === "tool" && m.toolCallId).map((m) => m.toolCallId as string),
  );
  const out: LLMMessage[] = [];
  const declared = new Set<string>();
  for (const m of window) {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const kept = m.toolCalls.filter((tc) => answered.has(tc.id));
      for (const tc of kept) declared.add(tc.id);
      if (kept.length === m.toolCalls.length) out.push(m);
      else if (kept.length > 0) out.push({ role: "assistant", content: m.content, toolCalls: kept });
      else if (m.content.trim().length > 0) out.push({ role: "assistant", content: m.content });
      // else: an unanswered, contentless tool-call turn — drop it entirely.
    } else if (m.role === "tool") {
      if (m.toolCallId && declared.has(m.toolCallId)) out.push(m); // drop orphan results
    } else {
      out.push(m);
    }
  }
  return out;
}
