import {
  asConversationId,
  asIdempotencyKey,
  asRequestId,
  asToolCallId,
  asWorkspaceId,
  type CallJournalEntry,
  type Cents,
  type Settings,
} from "@ortha/contracts";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/schema.js";
import { betterSqliteAdapter, type SqlDb } from "../src/sql.js";
import { createStore, DEFAULT_SETTINGS, estimateTokens, tryReserveSpend } from "../src/store.js";

const WS = asWorkspaceId("ws_1");

function freshDb(): SqlDb {
  const db = betterSqliteAdapter(new Database(":memory:"));
  applySchema(db);
  return db;
}

function makeStore() {
  const db = freshDb();
  return { db, store: createStore(db) };
}

describe("schema + adapter", () => {
  it("applies schema idempotently", () => {
    const db = freshDb();
    expect(() => applySchema(db)).not.toThrow(); // second apply is a no-op
    const row = db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='call_journal'`);
    expect(row?.name).toBe("call_journal");
  });
});

describe("conversation + message CRUD", () => {
  it("creates, gets, and lists conversations newest-first", async () => {
    const { store } = makeStore();
    const a = await store.createConversation(WS, "First");
    const b = await store.createConversation(WS, "Second");

    expect(await store.getConversation(a.id)).toEqual(a);
    expect(await store.getConversation(asConversationId("nope"))).toBeNull();

    const list = await store.listConversations(WS);
    expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
    expect(await store.listConversations(asWorkspaceId("other"))).toEqual([]);
  });

  it("appends messages, bumps updatedAt, and stores tool call ids", async () => {
    const { store } = makeStore();
    const conv = await store.createConversation(WS, "C");
    const tc = asToolCallId("tc_x");

    const m1 = await store.appendMessage({ conversationId: conv.id, role: "user", content: "hi" });
    const m2 = await store.appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: "hello",
      toolCallIds: [tc],
    });

    expect(m1.role).toBe("user");
    expect(m2.toolCallIds).toEqual([tc]);

    const reloaded = await store.getConversation(conv.id);
    expect(reloaded?.updatedAt).toBeGreaterThanOrEqual(conv.updatedAt);

    const all = await store.loadWindow(conv.id, 1_000_000);
    expect(all.map((m) => m.content)).toEqual(["hi", "hello"]); // chronological
    expect(all[1]?.toolCallIds).toEqual([tc]);
  });

  it("round-trips the tool transcript (assistant toolCalls + tool result name/id) for cross-turn expand", async () => {
    const { store } = makeStore();
    const conv = await store.createConversation(WS, "C");

    await store.appendMessage({ conversationId: conv.id, role: "user", content: "scrape example.com" });
    await store.appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "run_tool", args: { api: "ctx", path: "/scrape" } }],
    });
    await store.appendMessage({
      conversationId: conv.id,
      role: "tool",
      content: "ctx /scrape -> Example Domain (requestId: run_X)",
      toolCallId: "call_1",
      toolName: "run_tool",
      priceCents: 2.5,
      latencyMs: 4840,
    });

    const all = await store.loadWindow(conv.id, 1_000_000);
    const asst = all.find((m) => m.role === "assistant");
    expect(asst?.toolCalls).toEqual([{ id: "call_1", name: "run_tool", args: { api: "ctx", path: "/scrape" } }]);
    const tool = all.find((m) => m.role === "tool");
    expect(tool?.toolCallId).toBe("call_1");
    expect(tool?.toolName).toBe("run_tool");
    // Price (fractional cent) + latency round-trip via toolMeta, so a reopened
    // conversation can show them on the restored trace block.
    expect(tool?.priceCents).toBe(2.5);
    expect(tool?.latencyMs).toBe(4840);
    // The requestId survives in the tool content, so a later turn can expand_result it.
    expect(tool?.content).toContain("run_X");
  });
});

describe("tool calls", () => {
  it("records pending and patches fields, leaving others untouched", async () => {
    const { db, store } = makeStore();
    const conv = await store.createConversation(WS, "C");
    const call = await store.recordToolCall({
      conversationId: conv.id,
      api: "apollo",
      path: "/v1/people/match",
      idempotencyKey: asIdempotencyKey("idem_tc"),
    });
    expect(call.status).toBe("pending");
    expect(call.priceCents).toBeNull();

    await store.updateToolCall(call.id, { status: "settled", priceCents: 3 as Cents });
    await store.updateToolCall(call.id, { latencyMs: 120, requestId: asRequestId("run_1") });

    const row = db.get(`SELECT * FROM tool_calls WHERE id = ?`, [call.id]);
    expect(row?.status).toBe("settled");
    expect(Number(row?.priceCents)).toBe(3);
    expect(Number(row?.latencyMs)).toBe(120);
    expect(row?.requestId).toBe("run_1");

    await store.updateToolCall(call.id, {}); // empty patch is a no-op
    const after = db.get(`SELECT status FROM tool_calls WHERE id = ?`, [call.id]);
    expect(after?.status).toBe("settled");
  });
});

describe("loadWindow", () => {
  it("returns most-recent messages within budget, in chronological order", async () => {
    const { store } = makeStore();
    const conv = await store.createConversation(WS, "C");
    // Each message ~10 tokens (40 chars / 4).
    const body = "x".repeat(40);
    await store.appendMessage({ conversationId: conv.id, role: "user", content: `1${body}` });
    await store.appendMessage({ conversationId: conv.id, role: "assistant", content: `2${body}` });
    await store.appendMessage({ conversationId: conv.id, role: "user", content: `3${body}` });

    // Budget for ~2 messages (each ceil(41/4)=11 tokens → 22 fits, 33 does not).
    const win = await store.loadWindow(conv.id, 25);
    expect(win.length).toBe(2);
    expect(win.map((m) => m.content[0])).toEqual(["2", "3"]); // dropped oldest, chronological
  });

  it("returns nothing if even the newest message busts the budget", async () => {
    const { store } = makeStore();
    const conv = await store.createConversation(WS, "C");
    await store.appendMessage({ conversationId: conv.id, role: "user", content: "x".repeat(400) });
    expect(await store.loadWindow(conv.id, 1)).toEqual([]);
  });

  it("estimateTokens is chars/4 rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("call journal — write-once + settle", () => {
  const entry = (key: string): CallJournalEntry => ({
    idempotencyKey: asIdempotencyKey(key),
    conversationId: asConversationId("conv_j"),
    stepId: "step_1",
    state: "pending",
    requestId: null,
    priceCents: null,
    createdAt: Date.now(),
  });

  it("journalPending is write-once: second call returns false", async () => {
    const { store } = makeStore();
    expect(await store.journalPending(entry("k1"))).toBe(true);
    expect(await store.journalPending(entry("k1"))).toBe(false); // already exists
    expect(await store.journalPending(entry("k2"))).toBe(true);
  });

  it("settleJournal flips state and records requestId + price", async () => {
    const { store } = makeStore();
    await store.journalPending(entry("k3"));
    const before = await store.getJournal(asIdempotencyKey("k3"));
    expect(before?.state).toBe("pending");

    await store.settleJournal(asIdempotencyKey("k3"), asRequestId("run_k3"), 7 as Cents);
    const after = await store.getJournal(asIdempotencyKey("k3"));
    expect(after?.state).toBe("settled");
    expect(after?.requestId).toBe("run_k3");
    expect(after?.priceCents).toBe(7);
  });

  it("listUnsettledJournal returns only pending/unknown", async () => {
    const { db, store } = makeStore();
    await store.journalPending(entry("k4")); // pending
    await store.journalPending(entry("k5"));
    await store.settleJournal(asIdempotencyKey("k5"), asRequestId("run_k5"), 1 as Cents);
    // Force one row to 'unknown' directly.
    db.run(`UPDATE call_journal SET state = 'unknown' WHERE idempotencyKey = ?`, ["k4"]);

    const unsettled = await store.listUnsettledJournal();
    expect(unsettled.map((e) => e.idempotencyKey).sort()).toEqual(["k4"]);
  });

  it("getJournal returns null for unknown key", async () => {
    const { store } = makeStore();
    expect(await store.getJournal(asIdempotencyKey("missing"))).toBeNull();
  });
});

describe("settings round-trip", () => {
  it("returns defaults when none stored", async () => {
    const { store } = makeStore();
    expect(await store.getSettings(WS)).toEqual(DEFAULT_SETTINGS);
  });

  it("upserts and reads back, overwriting on second put", async () => {
    const { store } = makeStore();
    const s1: Settings = {
      sessionCapCents: 1000,
      perCallWarnCents: 50,
      monthlyCapCents: 20_000,
      model: "claude-sonnet",
      theme: "dark",
      cacheTtlSeconds: 600,
    };
    await store.putSettings(WS, s1);
    expect(await store.getSettings(WS)).toEqual(s1);

    const s2: Settings = { ...s1, theme: "light", model: "gpt-4o" };
    await store.putSettings(WS, s2);
    expect(await store.getSettings(WS)).toEqual(s2); // upsert overwrote, no duplicate row
  });
});

describe("tryReserveSpend — overspend is impossible", () => {
  const PERIOD = 1_700_000_000_000;

  it("accepts a reservation within cap", async () => {
    const db = freshDb();
    expect(await tryReserveSpend(db, WS, PERIOD, 40 as Cents, 100 as Cents)).toBe(true);
    const row = db.get(`SELECT reservedCents FROM spend WHERE workspaceId = ? AND periodStart = ?`, [
      WS,
      PERIOD,
    ]);
    expect(Number(row?.reservedCents)).toBe(40);
  });

  it("rejects a single over-cap reservation and leaves spend untouched", async () => {
    const db = freshDb();
    expect(await tryReserveSpend(db, WS, PERIOD, 150 as Cents, 100 as Cents)).toBe(false);
    const row = db.get(`SELECT reservedCents FROM spend WHERE workspaceId = ? AND periodStart = ?`, [
      WS,
      PERIOD,
    ]);
    expect(Number(row?.reservedCents)).toBe(0); // row seeded but nothing reserved
  });

  it("two sequential reserves cannot exceed the cap", async () => {
    const db = freshDb();
    expect(await tryReserveSpend(db, WS, PERIOD, 60 as Cents, 100 as Cents)).toBe(true);
    // 60 + 60 = 120 > 100 → rejected.
    expect(await tryReserveSpend(db, WS, PERIOD, 60 as Cents, 100 as Cents)).toBe(false);
    // 60 + 40 = 100 <= 100 → accepted (boundary).
    expect(await tryReserveSpend(db, WS, PERIOD, 40 as Cents, 100 as Cents)).toBe(true);
    // Now at the cap; any further reservation fails.
    expect(await tryReserveSpend(db, WS, PERIOD, 1 as Cents, 100 as Cents)).toBe(false);

    const row = db.get(`SELECT reservedCents FROM spend WHERE workspaceId = ? AND periodStart = ?`, [
      WS,
      PERIOD,
    ]);
    expect(Number(row?.reservedCents)).toBe(100);
  });

  it("counts settledCents against the cap too", async () => {
    const db = freshDb();
    await tryReserveSpend(db, WS, PERIOD, 0 as Cents, 100 as Cents); // seed row
    db.run(`UPDATE spend SET settledCents = 90 WHERE workspaceId = ? AND periodStart = ?`, [
      WS,
      PERIOD,
    ]);
    expect(await tryReserveSpend(db, WS, PERIOD, 20 as Cents, 100 as Cents)).toBe(false); // 90+20>100
    expect(await tryReserveSpend(db, WS, PERIOD, 10 as Cents, 100 as Cents)).toBe(true); // 90+10=100
  });
});

let beforeEachRan = false;
beforeEach(() => {
  beforeEachRan = true;
});
it("test harness sanity", () => {
  expect(beforeEachRan).toBe(true);
});
