// ConversationStore over a synchronous SqlDb. Every method is async per the frozen
// seam, but the body runs synchronously against better-sqlite3 (wrapped in resolved
// promises). This keeps one implementation usable from both a sync host and, with a
// thin shim, an async one.
//
// Correctness guarantees worth calling out:
//   - journalPending: write-once via INSERT OR IGNORE on a PK'd idempotencyKey.
//   - tryReserveSpend: a single conditional UPDATE; the cap check is in the WHERE
//     clause, so the DB — not app code — enforces "no overspend" atomically.
//   - loadWindow: most-recent messages whose approx token sum (chars/4) fits the
//     budget, returned oldest-first.

import type {
  CallJournalEntry,
  Cents,
  Conversation,
  ConversationStore,
  IdempotencyKey,
  Message,
  MessageRole,
  NewMessage,
  NewToolCall,
  RequestId,
  Settings,
  ToolCall,
  ToolCallId,
  ToolCallStatus,
  WorkspaceId,
} from "@ortha/contracts";
import { SettingsSchema } from "@ortha/contracts";
import type { SqlDb, SqlParam, SqlRow } from "./sql.js";

/** Default settings for a workspace that has never saved any. */
export const DEFAULT_SETTINGS: Settings = {
  sessionCapCents: 500,
  perCallWarnCents: 25,
  monthlyCapCents: 10_000,
  model: "gemini-2.5-flash",
  theme: "system",
  cacheTtlSeconds: 300,
};

/** chars/4 token estimate, matching the rest of the system's heuristic. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

let counter = 0;
/** Sortable-ish unique id: time + per-process counter + random. */
function genId(prefix: string): string {
  counter = (counter + 1) % 0x10000;
  const rand = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
  return `${prefix}_${Date.now().toString(36)}${counter.toString(16).padStart(4, "0")}${rand}`;
}

const num = (v: SqlParam | undefined): number => Number(v);
const numOrNull = (v: SqlParam | undefined): number | null => (v == null ? null : Number(v));
const strOrNull = (v: SqlParam | undefined): string | null => (v == null ? null : String(v));

function rowToConversation(r: SqlRow): Conversation {
  return {
    id: String(r.id) as Conversation["id"],
    workspaceId: String(r.workspaceId) as WorkspaceId,
    title: String(r.title),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  };
}

interface ToolMeta {
  toolCalls?: readonly { readonly id: string; readonly name: string; readonly args: Record<string, unknown> }[];
  toolCallId?: string;
  toolName?: string;
}

function parseToolMeta(v: SqlParam | undefined): ToolMeta {
  if (v == null) return {};
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === "object" && !Array.isArray(o) ? (o as ToolMeta) : {};
  } catch {
    return {};
  }
}

function toolMetaJson(m: NewMessage): string {
  const meta: ToolMeta = {};
  if (m.toolCalls && m.toolCalls.length > 0) meta.toolCalls = m.toolCalls;
  if (m.toolCallId) meta.toolCallId = m.toolCallId;
  if (m.toolName) meta.toolName = m.toolName;
  return JSON.stringify(meta);
}

function rowToMessage(r: SqlRow): Message {
  const ids = JSON.parse(String(r.toolCallIds)) as string[];
  const meta = parseToolMeta(r.toolMeta);
  return {
    id: String(r.id) as Message["id"],
    conversationId: String(r.conversationId) as Message["conversationId"],
    role: String(r.role) as MessageRole,
    content: String(r.content),
    createdAt: num(r.createdAt),
    toolCallIds: ids as unknown as readonly ToolCallId[],
    ...(meta.toolCalls ? { toolCalls: meta.toolCalls } : {}),
    ...(meta.toolCallId ? { toolCallId: meta.toolCallId } : {}),
    ...(meta.toolName ? { toolName: meta.toolName } : {}),
  };
}

function rowToToolCall(r: SqlRow): ToolCall {
  return {
    id: String(r.id) as ToolCallId,
    conversationId: String(r.conversationId) as ToolCall["conversationId"],
    api: String(r.api),
    path: String(r.path),
    idempotencyKey: String(r.idempotencyKey) as IdempotencyKey,
    status: String(r.status) as ToolCallStatus,
    priceCents: numOrNull(r.priceCents) as Cents | null,
    latencyMs: numOrNull(r.latencyMs),
    requestId: strOrNull(r.requestId) as RequestId | null,
    createdAt: num(r.createdAt),
  };
}

function rowToJournal(r: SqlRow): CallJournalEntry {
  return {
    idempotencyKey: String(r.idempotencyKey) as IdempotencyKey,
    conversationId: String(r.conversationId) as CallJournalEntry["conversationId"],
    stepId: String(r.stepId),
    state: String(r.state) as CallJournalEntry["state"],
    requestId: strOrNull(r.requestId) as RequestId | null,
    priceCents: numOrNull(r.priceCents) as Cents | null,
    createdAt: num(r.createdAt),
  };
}

export function createStore(db: SqlDb): ConversationStore {
  return {
    async createConversation(workspaceId, title) {
      const now = Date.now();
      const id = genId("conv");
      db.run(
        `INSERT INTO conversations (id, workspaceId, title, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?)`,
        [id, workspaceId, title, now, now],
      );
      return {
        id: id as Conversation["id"],
        workspaceId,
        title,
        createdAt: now,
        updatedAt: now,
      };
    },

    async getConversation(id) {
      const row = db.get(`SELECT * FROM conversations WHERE id = ?`, [id]);
      return row ? rowToConversation(row) : null;
    },

    async listConversations(workspaceId) {
      const rows = db.all(
        `SELECT * FROM conversations WHERE workspaceId = ? ORDER BY createdAt DESC, id DESC`,
        [workspaceId],
      );
      return rows.map(rowToConversation);
    },

    async appendMessage(message: NewMessage) {
      const now = Date.now();
      const id = genId("msg");
      const toolCallIds = message.toolCallIds ?? [];
      // Monotonic per-conversation sequence to disambiguate same-millisecond appends.
      const seqRow = db.get(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversationId = ?`,
        [message.conversationId],
      );
      const seq = seqRow ? num(seqRow.next) : 1;
      db.run(
        `INSERT INTO messages (id, conversationId, role, content, createdAt, seq, toolCallIds, toolMeta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          message.conversationId,
          message.role,
          message.content,
          now,
          seq,
          JSON.stringify(toolCallIds),
          toolMetaJson(message),
        ],
      );
      db.run(`UPDATE conversations SET updatedAt = ? WHERE id = ?`, [now, message.conversationId]);
      return {
        id: id as Message["id"],
        conversationId: message.conversationId,
        role: message.role,
        content: message.content,
        createdAt: now,
        toolCallIds,
        ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.toolName ? { toolName: message.toolName } : {}),
      };
    },

    async loadWindow(conversationId, tokenBudget) {
      // Newest-first, accumulate until the next message would bust the budget, then
      // reverse to chronological order.
      const rows = db.all(
        `SELECT * FROM messages WHERE conversationId = ? ORDER BY createdAt DESC, seq DESC`,
        [conversationId],
      );
      const picked: Message[] = [];
      let used = 0;
      for (const row of rows) {
        const msg = rowToMessage(row);
        const cost = estimateTokens(msg.content);
        if (used + cost > tokenBudget) break;
        used += cost;
        picked.push(msg);
      }
      picked.reverse();
      return picked;
    },

    async recordToolCall(call: NewToolCall) {
      const now = Date.now();
      const id = genId("tc");
      const status: ToolCallStatus = "pending";
      db.run(
        `INSERT INTO tool_calls
           (id, conversationId, api, path, idempotencyKey, status, priceCents, latencyMs, requestId, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
        [id, call.conversationId, call.api, call.path, call.idempotencyKey, status, now],
      );
      return {
        id: id as ToolCallId,
        conversationId: call.conversationId,
        api: call.api,
        path: call.path,
        idempotencyKey: call.idempotencyKey,
        status,
        priceCents: null,
        latencyMs: null,
        requestId: null,
        createdAt: now,
      };
    },

    async updateToolCall(id, patch) {
      const sets: string[] = [];
      const params: (string | number)[] = [];
      if (patch.status !== undefined) {
        sets.push("status = ?");
        params.push(patch.status);
      }
      if (patch.priceCents !== undefined) {
        sets.push("priceCents = ?");
        params.push(patch.priceCents);
      }
      if (patch.latencyMs !== undefined) {
        sets.push("latencyMs = ?");
        params.push(patch.latencyMs);
      }
      if (patch.requestId !== undefined) {
        sets.push("requestId = ?");
        params.push(patch.requestId);
      }
      if (sets.length === 0) return;
      params.push(id);
      db.run(`UPDATE tool_calls SET ${sets.join(", ")} WHERE id = ?`, params);
    },

    async journalPending(entry: CallJournalEntry) {
      // Write-once: INSERT OR IGNORE against the PK'd idempotencyKey. changes === 0
      // means the key already existed → this call must NOT proceed as a fresh charge.
      const { changes } = db.run(
        `INSERT OR IGNORE INTO call_journal
           (idempotencyKey, conversationId, stepId, state, requestId, priceCents, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.idempotencyKey,
          entry.conversationId,
          entry.stepId,
          entry.state,
          entry.requestId,
          entry.priceCents,
          entry.createdAt,
        ],
      );
      return changes > 0;
    },

    async settleJournal(key, requestId, priceCents) {
      db.run(
        `UPDATE call_journal SET state = 'settled', requestId = ?, priceCents = ?
         WHERE idempotencyKey = ?`,
        [requestId, priceCents, key],
      );
    },

    async getJournal(key) {
      const row = db.get(`SELECT * FROM call_journal WHERE idempotencyKey = ?`, [key]);
      return row ? rowToJournal(row) : null;
    },

    async listUnsettledJournal() {
      const rows = db.all(
        `SELECT * FROM call_journal WHERE state IN ('pending', 'unknown') ORDER BY createdAt ASC`,
      );
      return rows.map(rowToJournal);
    },

    async getSettings(workspaceId) {
      const row = db.get(`SELECT * FROM settings WHERE workspaceId = ?`, [workspaceId]);
      if (!row) return DEFAULT_SETTINGS;
      return SettingsSchema.parse({
        sessionCapCents: num(row.sessionCapCents),
        perCallWarnCents: num(row.perCallWarnCents),
        monthlyCapCents: num(row.monthlyCapCents),
        model: String(row.model),
        theme: String(row.theme),
        cacheTtlSeconds: num(row.cacheTtlSeconds),
      });
    },

    async putSettings(workspaceId, settings) {
      const s = SettingsSchema.parse(settings);
      db.run(
        `INSERT INTO settings
           (workspaceId, sessionCapCents, perCallWarnCents, monthlyCapCents, model, theme, cacheTtlSeconds)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspaceId) DO UPDATE SET
           sessionCapCents  = excluded.sessionCapCents,
           perCallWarnCents = excluded.perCallWarnCents,
           monthlyCapCents  = excluded.monthlyCapCents,
           model            = excluded.model,
           theme            = excluded.theme,
           cacheTtlSeconds  = excluded.cacheTtlSeconds`,
        [
          workspaceId,
          s.sessionCapCents,
          s.perCallWarnCents,
          s.monthlyCapCents,
          s.model,
          s.theme,
          s.cacheTtlSeconds,
        ],
      );
    },
  };
}

/**
 * Atomically reserve `cents` against a workspace's period budget. Overspend is
 * impossible because the cap test lives in the WHERE clause of a single UPDATE —
 * the database, not application code, decides whether the reservation fits, and it
 * does so under the row's write lock. Two concurrent callers serialize on that lock;
 * the second sees the first's `reservedCents` and is rejected if it would bust the cap.
 *
 * Returns true iff the reservation was applied (changes > 0).
 */
export async function tryReserveSpend(
  db: SqlDb,
  workspaceId: WorkspaceId,
  periodStart: number,
  cents: Cents,
  capCents: Cents,
): Promise<boolean> {
  // Ensure the row exists (no-op if already present); seed its cap.
  db.run(
    `INSERT OR IGNORE INTO spend (workspaceId, periodStart, reservedCents, settledCents, capCents)
     VALUES (?, ?, 0, 0, ?)`,
    [workspaceId, periodStart, capCents],
  );
  // The one atomic, conditional reservation. reserved + settled + new must fit the cap.
  const { changes } = db.run(
    `UPDATE spend
       SET reservedCents = reservedCents + ?
     WHERE workspaceId = ?
       AND periodStart = ?
       AND reservedCents + settledCents + ? <= capCents`,
    [cents, workspaceId, periodStart, cents],
  );
  return changes > 0;
}
