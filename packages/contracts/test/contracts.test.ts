import { describe, expect, it } from "vitest";
import {
  asConversationId,
  asIdempotencyKey,
  asWorkspaceId,
  OrthaError,
  PermissionResponseSchema,
  SettingsSchema,
  TraceEventSchema,
  type TraceEvent,
} from "../src/index.js";
import {
  makeMockAuthService,
  makeMockBudgetPolicy,
  makeMockConversationStore,
  makeMockKeyVault,
  makeMockLLMProvider,
  makeMockMemoryStore,
  makeMockModelRegistry,
  makeMockOrthogonalClient,
} from "../src/mocks/index.js";

describe("trace event schema", () => {
  it("parses each event variant", () => {
    const events: TraceEvent[] = [
      { type: "token", text: "hi" },
      { type: "tool_search", query: "find email", resultCount: 3 },
      { type: "tool_call_started", stepId: "s1", api: "apollo", path: "/v1/people/match", estCents: 3 },
      { type: "tool_result", stepId: "s1", requestId: "r1", summary: "ok", priceCents: 3, latencyMs: 240, ok: true },
      { type: "cost_update", sessionCents: 12, capCents: 100, workspaceRemainingCents: 9988 },
      { type: "permission_required", stepId: "s2", kind: "cost", estCents: 40, sessionCents: 82, capCents: 100 },
      { type: "permission_resolved", stepId: "s2", approved: true },
      { type: "self_heal", failedProvider: "apollo", altProvider: "clearbit" },
      { type: "error", code: "PROVIDER_DOWN", message: "down", providerSlug: "apollo" },
      { type: "done", stopReason: "end" },
    ];
    for (const e of events) expect(TraceEventSchema.parse(e)).toEqual(e);
  });

  it("rejects an unknown event type", () => {
    expect(() => TraceEventSchema.parse({ type: "nope" })).toThrow();
  });

  it("rejects an invalid error code", () => {
    expect(() => TraceEventSchema.parse({ type: "error", code: "WAT", message: "x" })).toThrow();
  });
});

describe("schemas", () => {
  it("parses valid settings and rejects negatives", () => {
    const s = { sessionCapCents: 100, perCallWarnCents: 10, monthlyCapCents: 1000, model: "gemini-flash", theme: "system", cacheTtlSeconds: 600 };
    expect(SettingsSchema.parse(s)).toEqual(s);
    expect(() => SettingsSchema.parse({ ...s, sessionCapCents: -1 })).toThrow();
  });

  it("parses a permission response", () => {
    expect(PermissionResponseSchema.parse({ stepId: "s1", decision: "approve" }).decision).toBe("approve");
    expect(PermissionResponseSchema.parse({ stepId: "s1", decision: "raise_cap", newCapCents: 500 }).newCapCents).toBe(500);
  });
});

describe("OrthaError", () => {
  it("carries code and retryable", () => {
    const e = new OrthaError("TIMEOUT", "slow", { providerSlug: "linkup", retryable: true });
    expect(e.code).toBe("TIMEOUT");
    expect(e.retryable).toBe(true);
    expect(e.providerSlug).toBe("linkup");
  });
});

describe("mocks satisfy the seams", () => {
  it("orthogonal client search/details/run/estimate", async () => {
    const o = makeMockOrthogonalClient();
    expect((await o.search({ prompt: "enrich" }))[0]?.slug).toBe("apollo");
    expect((await o.getDetails("apollo", "/v1/people/match")).sideEffect).toBe("read");
    const r = await o.run({ api: "apollo", path: "/v1/people/match", idempotencyKey: asIdempotencyKey("k1") });
    expect(r.priceCents).toBe(3);
    expect((await o.estimateCost([{ api: "apollo", path: "/p", expectedCalls: 2 }])).estimatedCents).toBe(6);
  });

  it("llm provider streams events to a terminal done", async () => {
    const llm = makeMockLLMProvider();
    const types: string[] = [];
    for await (const e of llm.streamCompletion({ model: "m", system: "", messages: [], tools: [], maxTokens: 100 })) {
      types.push(e.type);
    }
    expect(types.at(-1)).toBe("done");
  });

  it("budget denies spend over the cap", async () => {
    const b = makeMockBudgetPolicy();
    const ws = asWorkspaceId("w1");
    const conv = asConversationId("c1");
    expect((await b.checkEstimate(ws, conv, 50)).decision).toBe("ok");
    expect((await b.checkEstimate(ws, conv, 1_000_00)).decision).toBe("denied");
  });

  it("conversation store journals are write-once and settle", async () => {
    const s = makeMockConversationStore();
    const conv = asConversationId("c1");
    const key = asIdempotencyKey("k1");
    const entry = { idempotencyKey: key, conversationId: conv, stepId: "s1", state: "pending" as const, requestId: null, priceCents: null, createdAt: Date.now() };
    expect(await s.journalPending(entry)).toBe(true);
    expect(await s.journalPending(entry)).toBe(false); // write-once: replay is a no-op
    await s.settleJournal(key, asConversationId("r1") as never, 3);
    expect((await s.getJournal(key))?.state).toBe("settled");
  });

  it("memory store round-trips raw results by requestId", async () => {
    const m = makeMockMemoryStore();
    const conv = asConversationId("c1");
    const rid = "req_1" as never;
    await m.appendDistilled(conv, rid, "summary", { big: "payload" });
    expect(await m.getRaw(rid)).toEqual({ big: "payload" });
  });

  it("key vault stores and never exposes plaintext in metadata", async () => {
    const v = makeMockKeyVault();
    const ws = asWorkspaceId("w1");
    await v.putKey(ws, "orthogonal", "orth_live_secret1234");
    expect(await v.getKey(ws, "orthogonal")).toBe("orth_live_secret1234");
    const meta = await v.listKeys(ws);
    expect(meta[0]?.hint).toBe("1234");
    expect(JSON.stringify(meta)).not.toContain("secret");
  });

  it("auth + model registry smoke", async () => {
    const a = makeMockAuthService();
    expect((await a.loginGoogle("code")).token).toBeTruthy();
    expect(makeMockModelRegistry().defaultModelId()).toBe("gemini-flash");
  });
});
