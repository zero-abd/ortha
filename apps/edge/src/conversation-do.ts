import { runAgentTurn, type AgentDeps } from "@ortha/agent";
import {
  asConversationId,
  asWorkspaceId,
  type ConversationId,
  type LLMMessage,
  type PermissionResponse,
  type WorkspaceId,
} from "@ortha/contracts";
import { applySchema, createStore, type SqlDb } from "@ortha/db";
import type { ConversationStore } from "@ortha/contracts";
import { createDemoPorts } from "./demo.js";
import { doSqlAdapter } from "./do-sql.js";
import type { Env } from "./env.js";
import { buildLivePorts } from "./ports.js";

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
  private readonly conversationId: ConversationId;
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
    const wsParam = new URL(request.url).searchParams.get("ws");
    if (wsParam && /^[a-zA-Z0-9_-]{6,64}$/.test(wsParam)) this.workspaceId = asWorkspaceId(wsParam);
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
    await this.ctx.blockConcurrencyWhile(async () => applySchema(this.db));
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

  private async runTurn(ws: WebSocket, text: string): Promise<void> {
    await this.init();
    await this.store.appendMessage({ conversationId: this.conversationId, role: "user", content: text });

    const history = await this.store.loadWindow(this.conversationId, HISTORY_BUDGET_TOKENS);
    const messages: LLMMessage[] = history.map((m) => ({ role: m.role, content: m.content }));

    // Live ports when this workspace has BYOK keys configured; demo otherwise.
    const live = await buildLivePorts(this.env, this.workspaceId).catch(() => null);
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
