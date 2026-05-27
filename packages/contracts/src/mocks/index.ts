// In-memory mock factories for every seam. These let each Wave-1 module build and
// test in isolation before the real implementations exist. Not for production.
import type { AuthService, KeyMetadata, KeyProvider, KeyVault, Session } from "../auth.js";
import type { BudgetDecision, BudgetPolicy, ReservationId } from "../budget.js";
import type { CallJournalEntry, Cents, Conversation, Message, Settings, ToolCall } from "../domain.js";
import {
  asConversationId,
  asMessageId,
  asRequestId,
  asToolCallId,
  asUserId,
  asWorkspaceId,
  type ConversationId,
  type IdempotencyKey,
  type RequestId,
  type ToolCallId,
  type WorkspaceId,
} from "../ids.js";
import type { LLMEvent, LLMProvider, ModelInfo, ModelRegistry, StreamInput } from "../llm.js";
import type { MemoryHit, MemoryStore } from "../memory.js";
import type {
  CostEstimate,
  OrthogonalClient,
  RunInput,
  RunResult,
  SearchInput,
  ToolApi,
  ToolDetails,
} from "../orthogonal.js";
import type { ConversationStore, NewMessage, NewToolCall } from "../store.js";
import type { WebClient, WebPage, WebSearchResult } from "../web.js";

let counter = 0;
const uid = (p: string): string => `${p}_${(++counter).toString(36)}_${Date.now().toString(36)}`;

export function makeMockOrthogonalClient(
  overrides: Partial<OrthogonalClient> = {},
): OrthogonalClient {
  const base: OrthogonalClient = {
    async search(_input: SearchInput): Promise<readonly ToolApi[]> {
      return [
        {
          name: "Apollo.io",
          slug: "apollo",
          endpoints: [
            {
              id: "ep_1",
              path: "/v1/people/match",
              method: "POST",
              description: "Enrich person by email, name, or LinkedIn URL",
              price: "0.03",
              verified: true,
              score: 0.95,
            },
          ],
        },
      ];
    },
    async getDetails(api: string, path: string): Promise<ToolDetails> {
      return {
        api,
        path,
        method: "POST",
        inputSchema: { type: "object", properties: { email: { type: "string" } } },
        outputSchema: null,
        priceCents: 3,
        hasDynamicPricing: false,
        verified: true,
        sideEffect: "read",
        longRunning: false,
      };
    },
    async run(input: RunInput): Promise<RunResult> {
      return {
        success: true,
        priceCents: 3,
        data: { name: "Patrick Collison", title: "CEO", company: "Stripe", _key: input.idempotencyKey },
        requestId: asRequestId(uid("run")),
      };
    },
    async estimateCost(plan): Promise<CostEstimate> {
      const breakdown = plan.map((s) => ({ api: s.api, path: s.path, cents: 3 * s.expectedCalls, dynamic: false }));
      return {
        estimatedCents: breakdown.reduce((a, b) => a + b.cents, 0),
        breakdown,
        hasUnknownPrices: false,
        hasDynamicPricing: false,
      };
    },
  };
  return { ...base, ...overrides };
}

export function makeMockWebClient(overrides: Partial<WebClient> = {}): WebClient {
  const base: WebClient = {
    async search(query: string): Promise<readonly WebSearchResult[]> {
      return [
        { title: `Result for ${query}`, url: "https://example.com/a", snippet: "A relevant page about the query." },
        { title: "Second result", url: "https://example.com/b", snippet: "Another relevant page." },
      ];
    },
    async scrape(url: string): Promise<WebPage> {
      return { url, title: "Example Page", markdown: `# Example\n\nContents of ${url}.`, truncated: false };
    },
  };
  return { ...base, ...overrides };
}

/** Yields a scripted sequence of LLM events (defaults to a one-token answer). */
export function makeMockLLMProvider(script?: readonly LLMEvent[]): LLMProvider {
  const events: readonly LLMEvent[] =
    script ?? [
      { type: "token", text: "Hello." },
      { type: "usage", inputTokens: 10, outputTokens: 2 },
      { type: "done", stopReason: "end" },
    ];
  return {
    id: "anthropic",
    async *streamCompletion(_input: StreamInput): AsyncIterable<LLMEvent> {
      for (const e of events) yield e;
    },
  };
}

export function makeMockModelRegistry(): ModelRegistry {
  const models: ModelInfo[] = [
    {
      id: "gemini-flash",
      provider: "gemini",
      displayName: "Gemini Flash",
      inputPerMTokensCents: 0,
      outputPerMTokensCents: 0,
      supportsToolUse: true,
      free: true,
    },
    {
      id: "claude-sonnet",
      provider: "anthropic",
      displayName: "Claude Sonnet",
      inputPerMTokensCents: 300,
      outputPerMTokensCents: 1500,
      supportsToolUse: true,
      free: false,
    },
  ];
  return {
    list: () => models,
    get: (id) => models.find((m) => m.id === id),
    defaultModelId: () => "gemini-flash",
  };
}

export function makeMockBudgetPolicy(): BudgetPolicy {
  let reserved = 0;
  let settled = 0;
  const cap = 100_00; // $100
  return {
    async checkEstimate(_ws, _conv, estimateCents): Promise<BudgetDecision> {
      const ok = reserved + settled + estimateCents <= cap;
      return {
        decision: ok ? "ok" : "denied",
        reason: ok ? "within cap" : "would exceed workspace cap",
        sessionSpentCents: settled,
        sessionCapCents: cap,
        workspaceRemainingCents: cap - reserved - settled,
      };
    },
    async reserve(_ws, estimateCents): Promise<ReservationId> {
      reserved += estimateCents;
      return uid("res") as ReservationId;
    },
    async settle(_res, actualCents): Promise<void> {
      settled += actualCents;
      reserved = Math.max(0, reserved - actualCents);
    },
    async refund(): Promise<void> {
      reserved = 0;
    },
    async remaining(): Promise<Cents> {
      return cap - reserved - settled;
    },
  };
}

export function makeMockMemoryStore(): MemoryStore {
  const raws = new Map<string, unknown>();
  return {
    async appendDistilled(_conv, requestId, _summary, raw): Promise<void> {
      raws.set(requestId, raw);
    },
    async getRaw(requestId: RequestId): Promise<unknown | null> {
      return raws.get(requestId) ?? null;
    },
    async retrieve(): Promise<readonly MemoryHit[]> {
      return [];
    },
    async rollingSummary(): Promise<string | null> {
      return null;
    },
  };
}

export function makeMockConversationStore(): ConversationStore {
  const convos = new Map<string, Conversation>();
  const messages: Message[] = [];
  const toolCalls = new Map<string, ToolCall>();
  const journal = new Map<string, CallJournalEntry>();
  let settings: Settings = {
    sessionCapCents: 100,
    perCallWarnCents: 10,
    monthlyCapCents: 10_00,
    model: "gemini-flash",
    theme: "system",
    cacheTtlSeconds: 600,
  };
  return {
    async createConversation(workspaceId, title): Promise<Conversation> {
      const c: Conversation = {
        id: asConversationId(uid("conv")),
        workspaceId,
        title,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      convos.set(c.id, c);
      return c;
    },
    async getConversation(id): Promise<Conversation | null> {
      return convos.get(id) ?? null;
    },
    async listConversations(workspaceId): Promise<readonly Conversation[]> {
      return [...convos.values()].filter((c) => c.workspaceId === workspaceId);
    },
    async appendMessage(m: NewMessage): Promise<Message> {
      const msg: Message = {
        id: asMessageId(uid("msg")),
        conversationId: m.conversationId,
        role: m.role,
        content: m.content,
        createdAt: Date.now(),
        toolCallIds: m.toolCallIds ?? [],
      };
      messages.push(msg);
      return msg;
    },
    async loadWindow(conversationId, _tokenBudget): Promise<readonly Message[]> {
      return messages.filter((m) => m.conversationId === conversationId);
    },
    async recordToolCall(call: NewToolCall): Promise<ToolCall> {
      const tc: ToolCall = {
        id: asToolCallId(uid("tc")),
        conversationId: call.conversationId,
        api: call.api,
        path: call.path,
        idempotencyKey: call.idempotencyKey,
        status: "pending",
        priceCents: null,
        latencyMs: null,
        requestId: null,
        createdAt: Date.now(),
      };
      toolCalls.set(tc.id, tc);
      return tc;
    },
    async updateToolCall(id: ToolCallId, patch): Promise<void> {
      const tc = toolCalls.get(id);
      if (tc) toolCalls.set(id, { ...tc, ...patch });
    },
    async journalPending(entry: CallJournalEntry): Promise<boolean> {
      if (journal.has(entry.idempotencyKey)) return false;
      journal.set(entry.idempotencyKey, entry);
      return true;
    },
    async settleJournal(key: IdempotencyKey, requestId: RequestId, priceCents): Promise<void> {
      const e = journal.get(key);
      if (e) journal.set(key, { ...e, state: "settled", requestId, priceCents });
    },
    async getJournal(key: IdempotencyKey): Promise<CallJournalEntry | null> {
      return journal.get(key) ?? null;
    },
    async listUnsettledJournal(): Promise<readonly CallJournalEntry[]> {
      return [...journal.values()].filter((e) => e.state !== "settled");
    },
    async getSettings(_ws: WorkspaceId): Promise<Settings> {
      return settings;
    },
    async putSettings(_ws: WorkspaceId, s: Settings): Promise<void> {
      settings = s;
    },
  };
}

export function makeMockAuthService(): AuthService {
  const session = (): Session => ({
    userId: asUserId(uid("user")),
    workspaceId: asWorkspaceId(uid("ws")),
    token: uid("tok"),
    expiresAt: Date.now() + 3_600_000,
  });
  return {
    async signupEmail(): Promise<Session> {
      return session();
    },
    async loginEmail(): Promise<Session> {
      return session();
    },
    async loginGoogle(): Promise<Session> {
      return session();
    },
    async session(token: string): Promise<Session | null> {
      return token ? { ...session(), token } : null;
    },
  };
}

export function makeMockKeyVault(): KeyVault {
  const keys = new Map<string, string>();
  const k = (ws: WorkspaceId, p: KeyProvider): string => `${ws}:${p}`;
  return {
    async putKey(ws, provider, plaintext): Promise<void> {
      keys.set(k(ws, provider), plaintext);
    },
    async getKey(ws, provider): Promise<string | null> {
      return keys.get(k(ws, provider)) ?? null;
    },
    async rotate(ws, provider, newPlaintext): Promise<void> {
      keys.set(k(ws, provider), newPlaintext);
    },
    async revoke(ws, provider): Promise<void> {
      keys.delete(k(ws, provider));
    },
    async listKeys(ws): Promise<readonly KeyMetadata[]> {
      const out: KeyMetadata[] = [];
      for (const [key, val] of keys) {
        if (key.startsWith(`${ws}:`)) {
          out.push({
            provider: key.slice(ws.length + 1) as KeyProvider,
            version: 1,
            status: "active",
            hint: val.slice(-4),
          });
        }
      }
      return out;
    },
  };
}
