import type {
  CallJournalEntry,
  Cents,
  Conversation,
  Message,
  MessageRole,
  Settings,
  ToolCall,
  ToolCallStatus,
} from "./domain.js";
import type {
  ConversationId,
  IdempotencyKey,
  RequestId,
  ToolCallId,
  WorkspaceId,
} from "./ids.js";

export interface NewMessage {
  readonly conversationId: ConversationId;
  readonly role: MessageRole;
  readonly content: string;
  readonly toolCallIds?: readonly ToolCallId[];
}

export interface NewToolCall {
  readonly conversationId: ConversationId;
  readonly api: string;
  readonly path: string;
  readonly idempotencyKey: IdempotencyKey;
}

/**
 * Relational persistence seam (D1). The Conversation DO's SQLite is the source of
 * truth for live state; this store is the queryable mirror, updated via an
 * idempotent outbox flush, and the home of cross-conversation queries.
 */
export interface ConversationStore {
  createConversation(workspaceId: WorkspaceId, title: string): Promise<Conversation>;
  getConversation(id: ConversationId): Promise<Conversation | null>;
  listConversations(workspaceId: WorkspaceId): Promise<readonly Conversation[]>;

  appendMessage(message: NewMessage): Promise<Message>;
  /** Most recent messages whose estimated token sum fits `tokenBudget`. */
  loadWindow(conversationId: ConversationId, tokenBudget: number): Promise<readonly Message[]>;

  recordToolCall(call: NewToolCall): Promise<ToolCall>;
  updateToolCall(
    id: ToolCallId,
    patch: {
      status?: ToolCallStatus;
      priceCents?: Cents;
      latencyMs?: number;
      requestId?: RequestId;
    },
  ): Promise<void>;

  // ── Durable call journal (at-least-once + reconciliation) ──
  /** Write BEFORE executing a paid call. Returns false if the key already exists. */
  journalPending(entry: CallJournalEntry): Promise<boolean>;
  settleJournal(key: IdempotencyKey, requestId: RequestId, priceCents: Cents): Promise<void>;
  getJournal(key: IdempotencyKey): Promise<CallJournalEntry | null>;
  /** All entries stuck pending/unknown — reconciled against Orthogonal /v1/usage. */
  listUnsettledJournal(): Promise<readonly CallJournalEntry[]>;

  getSettings(workspaceId: WorkspaceId): Promise<Settings>;
  putSettings(workspaceId: WorkspaceId, settings: Settings): Promise<void>;
}
