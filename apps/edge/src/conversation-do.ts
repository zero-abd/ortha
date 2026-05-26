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
import { createDemoPorts } from "./demo.js";
import { doSqlAdapter } from "./do-sql.js";
import type { Env } from "./env.js";
import { buildLivePorts } from "./ports.js";
import { DurableSpendStore, SESSION_SPEND_DDL, WORKSPACE_SPEND_DDL } from "./spend-store.js";

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
    const wsParam = url.searchParams.get("ws");
    if (wsParam && /^[a-zA-Z0-9_-]{6,64}$/.test(wsParam)) this.workspaceId = asWorkspaceId(wsParam);
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
    this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private handleSession(ws: WebSocket): void {
    ws.accept();
    void this.sendHistory(ws);
    ws.addEventListener("message", (ev) => void this.onMessage(ws, ev));
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      applySchema(this.db);
      // DO-local per-conversation session spend (accumulates across turns).
      this.db.run(SESSION_SPEND_DDL);
      // D1 cross-conversation workspace monthly spend.
      await d1Adapter(this.env.DB).run(WORKSPACE_SPEND_DDL);
    });
    this.initialized = true;
  }

  private async sendHistory(ws: WebSocket): Promise<void> {
    await this.init();
    const msgs = await this.store.loadWindow(this.conversationId, HISTORY_BUDGET_TOKENS);
    ws.send(JSON.stringify({ type: "history", messages: msgs.map((m) => ({ role: m.role, content: m.content })) }));
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
    const messages: LLMMessage[] = history.map((m) => ({ role: m.role, content: m.content }));

    // Durable spend store: workspace monthly spend in D1, session spend in this DO's
    // SQLite. Seeded with the workspace's monthly cap so `remaining()` is correct.
    const monthlyCapCents = await this.resolveMonthlyCapCents();
    const spendStore = new DurableSpendStore({
      d1: d1Adapter(this.env.DB),
      doSql: this.db,
      monthlyCapCents,
    });

    // Live ports when this workspace has BYOK keys configured; demo otherwise.
    const live = await buildLivePorts(this.env, this.workspaceId, spendStore).catch(() => null);
    const ports = live ?? { ...createDemoPorts(), model: "demo" };
    const deps: AgentDeps = {
      llm: ports.llm,
      orthogonal: ports.orthogonal,
      budget: ports.budget,
      memory: ports.memory,
      model: ports.model,
      workspaceId: this.workspaceId,
      conversationId: this.conversationId,
      requestPermission: (event) =>
        new Promise<PermissionResponse>((resolve) => {
          this.pendingPermission = resolve;
          ws.send(JSON.stringify(event));
        }),
      checkpoint: async (state) => {
        await this.ctx.storage.put("step", state.step);
      },
    };

    let answer = "";
    try {
      for await (const event of runAgentTurn(deps, { messages })) {
        if (event.type === "token") answer += event.text;
        ws.send(JSON.stringify(event));
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", code: "PROVIDER_DOWN", message: e instanceof Error ? e.message : "loop error" }));
    }
    await this.store.appendMessage({ conversationId: this.conversationId, role: "assistant", content: answer });
  }
}
