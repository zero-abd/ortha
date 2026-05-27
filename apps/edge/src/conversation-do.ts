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
import { buildLivePorts } from "./ports.js";
import { createSqlRawStore, RAW_BLOBS_DDL } from "./raw-store.js";
import { DurableSpendStore, SESSION_SPEND_DDL, WORKSPACE_SPEND_DDL } from "./spend-store.js";
import { kvSessionStore } from "./auth-stores.js";

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
    // The transcript now includes tool-call plumbing (assistant tool-call turns +
    // tool results) for cross-turn expand. The UI only wants real chat turns, so
    // show user messages and assistant messages that actually said something.
    const visible = msgs.filter((m) => m.role === "user" || (m.role === "assistant" && m.content.trim().length > 0));
    ws.send(JSON.stringify({ type: "history", messages: visible.map((m) => ({ role: m.role, content: m.content })) }));
  }

  private async onMessage(ws: WebSocket, ev: MessageEvent): Promise<void> {
    let msg: { type?: string; text?: string; response?: PermissionResponse };
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
    this.running = true;
    try {
      await this.runTurn(ws, msg.text);
    } finally {
      this.running = false;
    }
  }

  /** Upsert this conversation into the per-workspace index (KV) so the sidebar can list it. */
  private async registerConversation(title: string): Promise<void> {
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
      existing.updatedAt = Date.now();
      if (!existing.title) existing.title = title;
    } else {
      list.unshift({ id, title, updatedAt: Date.now() });
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    if (list.length > 50) list = list.slice(0, 50);
    await this.env.KV.put(key, JSON.stringify(list));
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

  private async runTurn(ws: WebSocket, text: string): Promise<void> {
    await this.init();
    await this.store.appendMessage({ conversationId: this.conversationId, role: "user", content: text });
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
    const deps: AgentDeps = {
      llm: ports.llm,
      orthogonal: ports.orthogonal,
      budget: ports.budget,
      memory: ports.memory,
      model: ports.model,
      workspaceId: this.workspaceId,
      conversationId: this.conversationId,
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
        await this.store.appendMessage({
          conversationId: this.conversationId,
          role: m.role,
          content: m.content,
          ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
          ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
          ...(m.toolName ? { toolName: m.toolName } : {}),
        });
      },
    };

    try {
      for await (const event of runAgentTurn(deps, { messages })) {
        ws.send(JSON.stringify(event));
      }
    } catch (e) {
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
