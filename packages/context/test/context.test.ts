import { asConversationId, asRequestId, type ConversationId, type LLMMessage, type ToolSpec } from "@ortha/contracts";
import { distill } from "@ortha/harness";
import { describe, expect, it, vi } from "vitest";
import { buildContextWindow } from "../src/budget.js";
import { rankByOverlap } from "../src/retrieval.js";
import { createMemoryStore, mapKvPort, type ConvSummaryState } from "../src/store.js";
import { estimateTokens, messageTokens } from "../src/tokens.js";

const CONV = asConversationId("conv_1");

// Deterministic summarizer built on the harness distill fallback: collapse the
// folded text to its distilled form, prefixed so tests can detect a call.
const distillSummarize = async (text: string): Promise<string> => `rolled:${distill({ text }).summary}`;

function freshStore(opts?: { rollingThreshold?: number; summarize?: (t: string) => Promise<string> }) {
  const raw = new Map<string, unknown>();
  const summary = new Map<string, ConvSummaryState>();
  const summarize = vi.fn(opts?.summarize ?? distillSummarize);
  const store = createMemoryStore({
    rawStore: mapKvPort(raw),
    summaryStore: mapKvPort(summary),
    summarize,
    ...(opts?.rollingThreshold !== undefined ? { rollingThreshold: opts.rollingThreshold } : {}),
  });
  return { store, raw, summary, summarize };
}

describe("token estimation", () => {
  it("approximates tokens at ~chars/4, rounding up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2); // ceil(5/4)
  });

  it("adds a small per-message framing constant", () => {
    const m: LLMMessage = { role: "user", content: "abcd" };
    expect(messageTokens(m)).toBe(2); // 1 (content) + 1 framing
  });
});

describe("appendDistilled + getRaw", () => {
  it("round-trips the raw payload by requestId", async () => {
    const { store } = freshStore();
    const rid = asRequestId("run_1");
    const raw = { name: "Patrick", nested: { count: 42 } };
    await store.appendDistilled(CONV, rid, "Patrick · 42", raw);

    expect(await store.getRaw(rid)).toEqual(raw);
  });

  it("returns null for an unknown requestId", async () => {
    const { store } = freshStore();
    expect(await store.getRaw(asRequestId("missing"))).toBeNull();
  });

  it("keeps raw payloads keyed per requestId across multiple appends", async () => {
    const { store } = freshStore();
    await store.appendDistilled(CONV, asRequestId("a"), "sum a", { v: "A" });
    await store.appendDistilled(CONV, asRequestId("b"), "sum b", { v: "B" });
    expect(await store.getRaw(asRequestId("a"))).toEqual({ v: "A" });
    expect(await store.getRaw(asRequestId("b"))).toEqual({ v: "B" });
  });
});

describe("retrieve — keyword overlap ranking", () => {
  it("ranks the keyword-overlapping summary highest", async () => {
    const { store } = freshStore();
    await store.appendDistilled(CONV, asRequestId("1"), "the weather in paris is sunny", {});
    await store.appendDistilled(CONV, asRequestId("2"), "stock prices fell sharply today", {});
    await store.appendDistilled(CONV, asRequestId("3"), "paris weather forecast cloudy", {});

    const hits = await store.retrieve(CONV, "paris weather", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text).toContain("paris");
    // Two summaries mention both query tokens; the unrelated stock one is excluded.
    expect(hits.every((h) => /paris|weather/.test(h.text))).toBe(true);
    expect(hits.find((h) => h.text.includes("stock"))).toBeUndefined();
    expect(hits[0]?.source).toBe("tool_result");
  });

  it("respects k", async () => {
    const { store } = freshStore();
    for (let i = 0; i < 5; i++) {
      await store.appendDistilled(CONV, asRequestId(`r${i}`), `paris note number ${i}`, {});
    }
    const hits = await store.retrieve(CONV, "paris", 2);
    expect(hits).toHaveLength(2);
  });

  it("returns scores in 0..1 and descending order", async () => {
    const { store } = freshStore();
    await store.appendDistilled(CONV, asRequestId("1"), "alpha beta gamma delta", {});
    await store.appendDistilled(CONV, asRequestId("2"), "alpha only", {});
    const hits = await store.retrieve(CONV, "alpha beta", 5);
    expect(hits[0]?.score).toBe(1); // both query tokens present
    expect(hits[1]?.score).toBe(0.5); // only "alpha"
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
  });

  it("returns nothing for an empty store or zero k", async () => {
    const { store } = freshStore();
    expect(await store.retrieve(CONV, "anything", 3)).toHaveLength(0);
    await store.appendDistilled(CONV, asRequestId("1"), "paris", {});
    expect(await store.retrieve(CONV, "paris", 0)).toHaveLength(0);
  });

  it("isolates summaries per conversation", async () => {
    const { store } = freshStore();
    const other = asConversationId("conv_2");
    await store.appendDistilled(CONV, asRequestId("1"), "paris weather", {});
    expect(await store.retrieve(other, "paris", 3)).toHaveLength(0);
  });
});

describe("rankByOverlap (unit)", () => {
  it("returns empty for empty query", () => {
    expect(rankByOverlap(["paris weather"], "", 3)).toHaveLength(0);
  });
});

describe("rollingSummary", () => {
  it("returns null while the conversation is short", async () => {
    const { store, summarize } = freshStore({ rollingThreshold: 10 });
    for (let i = 0; i < 5; i++) {
      await store.appendDistilled(CONV, asRequestId(`r${i}`), `turn ${i}`, {});
    }
    expect(await store.rollingSummary(CONV)).toBeNull();
    expect(summarize).not.toHaveBeenCalled();
  });

  it("folds older items via summarize once the threshold is exceeded", async () => {
    const threshold = 3;
    const { store, summarize } = freshStore({ rollingThreshold: threshold });
    for (let i = 0; i < 5; i++) {
      await store.appendDistilled(CONV, asRequestId(`r${i}`), `turn ${i}`, {});
    }
    const rolling = await store.rollingSummary(CONV);
    expect(rolling).not.toBeNull();
    expect(summarize).toHaveBeenCalledTimes(1);
    // 5 items, threshold 3 → fold the 2 oldest ("turn 0", "turn 1").
    const foldedArg = summarize.mock.calls[0]?.[0] as string;
    expect(foldedArg).toContain("turn 0");
    expect(foldedArg).toContain("turn 1");
    expect(rolling).toContain("rolled:");
  });

  it("keeps the recent window retrievable after folding, and idempotent below threshold", async () => {
    const threshold = 3;
    const { store, summarize } = freshStore({ rollingThreshold: threshold });
    for (let i = 0; i < 4; i++) {
      await store.appendDistilled(CONV, asRequestId(`r${i}`), `paris turn ${i}`, {});
    }
    await store.rollingSummary(CONV); // folds the 1 oldest, leaving 3
    expect(summarize).toHaveBeenCalledTimes(1);
    // Now at threshold → calling again does not re-fold.
    await store.rollingSummary(CONV);
    expect(summarize).toHaveBeenCalledTimes(1);
    // The recent (un-folded) summaries are still retrievable.
    const hits = await store.retrieve(CONV, "paris", 10);
    expect(hits).toHaveLength(3);
  });

  it("incorporates the prior rolling summary when folding again", async () => {
    const threshold = 2;
    const { store, summarize } = freshStore({
      rollingThreshold: threshold,
      summarize: async (t) => `R[${t.replace(/\n/g, "|")}]`,
    });
    for (let i = 0; i < 4; i++) {
      await store.appendDistilled(CONV, asRequestId(`r${i}`), `t${i}`, {});
    }
    const first = await store.rollingSummary(CONV); // folds t0,t1
    expect(first).toBe("R[t0|t1]");
    await store.appendDistilled(CONV, asRequestId("r4"), "t4", {});
    await store.appendDistilled(CONV, asRequestId("r5"), "t5", {});
    const second = await store.rollingSummary(CONV); // folds prior rolling + t2,t3
    expect(second).toContain("R[t0|t1]");
    expect(second).toContain("t2");
    expect(second).toContain("t3");
  });
});

describe("buildContextWindow", () => {
  const system = "You are a helpful assistant.";
  const msgs = (n: number): LLMMessage[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `message body number ${i}` }) as LLMMessage);

  function totalTokens(out: LLMMessage[], tools: readonly ToolSpec[] = []): number {
    const msgT = out.reduce((s, m) => s + messageTokens(m), 0);
    const toolT = tools.reduce(
      (s, t) => s + estimateTokens(t.name) + estimateTokens(t.description) + estimateTokens(JSON.stringify(t.inputSchema)),
      0,
    );
    return msgT + toolT;
  }

  it("stays within tokenBudget with a generous budget", () => {
    const out = buildContextWindow({ system, recentMessages: msgs(6), tokenBudget: 1000 });
    expect(totalTokens(out)).toBeLessThanOrEqual(1000);
    // First message is always the system prompt.
    expect(out[0]?.role).toBe("system");
    expect(out[0]?.content).toBe(system);
  });

  it("always preserves system + the latest message under a tiny budget", () => {
    const recent = msgs(8);
    const latest = recent[recent.length - 1]!;
    const out = buildContextWindow({ system, recentMessages: recent, tokenBudget: 1 });
    expect(out[0]?.content).toBe(system);
    expect(out[out.length - 1]?.content).toBe(latest.content);
    // Under a tiny budget the non-essentials are dropped.
    expect(out).toHaveLength(2);
  });

  it("drops oldest non-essential messages first when the budget is tight", () => {
    const recent = msgs(10);
    // Floor (system + latest) ~15 tokens; budget 30 leaves room for a couple older
    // messages (~7 each) but not all 8 of them.
    const out = buildContextWindow({ system, recentMessages: recent, tokenBudget: 30 });
    expect(totalTokens(out)).toBeLessThanOrEqual(30);
    const latest = recent[recent.length - 1]!;
    expect(out[out.length - 1]?.content).toBe(latest.content);
    // Some older messages fit, but not all 10.
    expect(out.length).toBeGreaterThan(2);
    expect(out.length).toBeLessThan(recent.length + 1);
    // The very oldest ("message body number 0") is dropped before newer ones.
    const contents = out.map((m) => m.content);
    expect(contents).not.toContain("message body number 0");
    // A message just before the latest is retained over the oldest.
    expect(contents).toContain("message body number 8");
  });

  it("includes the rolling summary as a system note when budget allows", () => {
    const out = buildContextWindow({ system, summary: "earlier we discussed paris", recentMessages: msgs(2), tokenBudget: 1000 });
    expect(out.some((m) => m.role === "system" && m.content.includes("earlier we discussed paris"))).toBe(true);
  });

  it("includes retrieved hits only if budget allows and never exceeds budget", () => {
    const retrieved = [
      { text: "retrieved fact one about paris", score: 1, source: "tool_result" as const },
      { text: "retrieved fact two about london", score: 0.5, source: "tool_result" as const },
    ];
    const generous = buildContextWindow({ system, retrieved, recentMessages: msgs(2), tokenBudget: 1000 });
    expect(generous.some((m) => m.content.includes("paris"))).toBe(true);
    expect(totalTokens(generous)).toBeLessThanOrEqual(1000);

    // Tight budget: retrieved hits are dropped but window still valid.
    const tight = buildContextWindow({ system, retrieved, recentMessages: msgs(2), tokenBudget: 12 });
    expect(tight.some((m) => m.content.includes("Relevant context"))).toBe(false);
  });

  it("reserves budget for tool schemas", () => {
    const tools: ToolSpec[] = [
      { name: "search_tools", description: "find tools matching a prompt", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    ];
    const out = buildContextWindow({ system, recentMessages: msgs(6), toolSchemas: tools, tokenBudget: 1000 });
    expect(totalTokens(out, tools)).toBeLessThanOrEqual(1000);
  });

  it("handles an empty recentMessages list", () => {
    const out = buildContextWindow({ system, recentMessages: [], tokenBudget: 1000 });
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toBe(system);
  });
});
