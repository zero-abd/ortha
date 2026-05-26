import {
  asConversationId,
  asIdempotencyKey,
  asWorkspaceId,
  ErrorCode,
  isOrthaError,
  type Cents,
  type WorkspaceId,
} from "@ortha/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { createBudgetPolicy, type BudgetSettings } from "../src/policy.js";
import { InMemorySpendStore } from "../src/store.js";

const WS = asWorkspaceId("ws_1");
const CONV = asConversationId("conv_1");

// perCallWarnCents: 0 disables the per-call warn for the baseline suite, isolating
// the session/workspace-cap behaviour the existing tests assert.
const SETTINGS: BudgetSettings = { sessionCapCents: 100, monthlyCapCents: 1000, perCallWarnCents: 0 };

function setup(settings: BudgetSettings = SETTINGS) {
  const store = new InMemorySpendStore((_ws: WorkspaceId) => settings.monthlyCapCents);
  const policy = createBudgetPolicy({ store, settings });
  return { store, policy };
}

let env = setup();
beforeEach(() => {
  env = setup();
});

describe("checkEstimate", () => {
  it("returns 'ok' when within both session and workspace caps", async () => {
    const d = await env.policy.checkEstimate(WS, CONV, 50);
    expect(d.decision).toBe("ok");
    expect(d.sessionSpentCents).toBe(0);
    expect(d.sessionCapCents).toBe(100);
    expect(d.workspaceRemainingCents).toBe(1000);
  });

  it("returns 'permission_required' when crossing the session cap but workspace is fine", async () => {
    const d = await env.policy.checkEstimate(WS, CONV, 150); // 0 + 150 > 100 session, 150 <= 1000 ws
    expect(d.decision).toBe("permission_required");
    expect(d.workspaceRemainingCents).toBe(1000);
  });

  it("returns 'permission_required' once prior session spend pushes the next call over the soft cap", async () => {
    // Spend 80¢ in the session via a settled reservation.
    await env.policy.checkEstimate(WS, CONV, 80);
    const r = await env.policy.reserve(WS, 80, asIdempotencyKey("k_warm"));
    await env.policy.settle(r, 80);

    const d = await env.policy.checkEstimate(WS, CONV, 30); // 80 + 30 = 110 > 100
    expect(d.decision).toBe("permission_required");
    expect(d.sessionSpentCents).toBe(80);
  });

  it("returns 'denied' when the estimate exceeds the workspace remaining", async () => {
    const d = await env.policy.checkEstimate(WS, CONV, 1200); // > 1000 ws cap
    expect(d.decision).toBe("denied");
  });

  it("denial takes precedence over the session-cap check", async () => {
    // Exceeds both caps; the hard workspace ceiling wins.
    const d = await env.policy.checkEstimate(WS, CONV, 5000);
    expect(d.decision).toBe("denied");
  });

  it("treats exactly hitting the session cap as ok (strict > only)", async () => {
    const d = await env.policy.checkEstimate(WS, CONV, 100); // 0 + 100 == 100, not > 100
    expect(d.decision).toBe("ok");
  });
});

describe("per-call warn threshold", () => {
  // sessionCap 1000 so the session cap never fires; isolate the per-call warn.
  const WARN: BudgetSettings = { sessionCapCents: 1000, monthlyCapCents: 10_000, perCallWarnCents: 25 };
  function warnEnv() {
    const store = new InMemorySpendStore((_ws: WorkspaceId) => WARN.monthlyCapCents);
    const policy = createBudgetPolicy({ store, settings: WARN });
    return { store, policy };
  }

  it("requires permission for a single call at/above the per-call warn threshold, even under the session cap", async () => {
    const { policy } = warnEnv();
    const d = await policy.checkEstimate(WS, CONV, 30); // 30 >= 25 warn, 30 < 1000 session
    expect(d.decision).toBe("permission_required");
    expect(d.reason).toContain("per-call warn threshold");
  });

  it("triggers exactly at the threshold (>=, not strictly >)", async () => {
    const { policy } = warnEnv();
    const d = await policy.checkEstimate(WS, CONV, 25); // 25 >= 25
    expect(d.decision).toBe("permission_required");
    expect(d.reason).toContain("per-call warn threshold");
  });

  it("stays 'ok' for a call below the threshold and under the session cap", async () => {
    const { policy } = warnEnv();
    const d = await policy.checkEstimate(WS, CONV, 24); // 24 < 25, under session cap
    expect(d.decision).toBe("ok");
  });

  it("uses the distinct session-cap reason when only the session cap is crossed", async () => {
    // perCallWarn high enough that the single call doesn't warn, but session cap is tiny.
    const settings: BudgetSettings = { sessionCapCents: 20, monthlyCapCents: 10_000, perCallWarnCents: 1000 };
    const store = new InMemorySpendStore((_ws: WorkspaceId) => settings.monthlyCapCents);
    const policy = createBudgetPolicy({ store, settings });
    const d = await policy.checkEstimate(WS, CONV, 30); // 30 < 1000 warn, but 0+30 > 20 session
    expect(d.decision).toBe("permission_required");
    expect(d.reason).toContain("session cap");
    expect(d.reason).not.toContain("per-call warn threshold");
  });

  it("a per-call-warn estimate over the workspace cap is still denied (hard ceiling wins)", async () => {
    const settings: BudgetSettings = { sessionCapCents: 1000, monthlyCapCents: 100, perCallWarnCents: 25 };
    const store = new InMemorySpendStore((_ws: WorkspaceId) => settings.monthlyCapCents);
    const policy = createBudgetPolicy({ store, settings });
    const d = await policy.checkEstimate(WS, CONV, 200); // 200 >= 25 warn, but 200 > 100 ws
    expect(d.decision).toBe("denied");
  });

  it("perCallWarnCents = 0 disables the warn entirely", async () => {
    const settings: BudgetSettings = { sessionCapCents: 1000, monthlyCapCents: 10_000, perCallWarnCents: 0 };
    const store = new InMemorySpendStore((_ws: WorkspaceId) => settings.monthlyCapCents);
    const policy = createBudgetPolicy({ store, settings });
    const d = await policy.checkEstimate(WS, CONV, 500); // big single call, but warn disabled
    expect(d.decision).toBe("ok");
  });
});

describe("reserve", () => {
  it("returns a ReservationId and reduces remaining by the estimate", async () => {
    const r = await env.policy.reserve(WS, 200, asIdempotencyKey("k1"));
    expect(typeof r).toBe("string");
    expect(await env.policy.remaining(WS)).toBe(800);
  });

  it("throws BUDGET_EXCEEDED when a single reserve exceeds the workspace cap", async () => {
    const err = await env.policy.reserve(WS, 1001, asIdempotencyKey("k_big")).catch((e) => e);
    expect(isOrthaError(err)).toBe(true);
    expect(isOrthaError(err) && err.code).toBe(ErrorCode.BUDGET_EXCEEDED);
    expect(await env.policy.remaining(WS)).toBe(1000); // nothing held
  });

  it("prevents overspend: two reserves that together exceed the cap -> second throws", async () => {
    await env.policy.reserve(WS, 700, asIdempotencyKey("k_a"));
    const err = await env.policy.reserve(WS, 400, asIdempotencyKey("k_b")).catch((e) => e); // 700 + 400 = 1100 > 1000
    expect(isOrthaError(err) && err.code).toBe(ErrorCode.BUDGET_EXCEEDED);
    expect(await env.policy.remaining(WS)).toBe(300); // only the first hold stands
  });

  it("is replay-safe: re-reserving the same idempotencyKey returns the same id and does not double-hold", async () => {
    const key = asIdempotencyKey("k_replay");
    const r1 = await env.policy.reserve(WS, 200, key);
    const r2 = await env.policy.reserve(WS, 200, key);
    expect(r1).toBe(r2);
    expect(await env.policy.remaining(WS)).toBe(800); // held once, not twice
  });

  it("allows reserving exactly up to the cap", async () => {
    const r = await env.policy.reserve(WS, 1000, asIdempotencyKey("k_exact"));
    expect(typeof r).toBe("string");
    expect(await env.policy.remaining(WS)).toBe(0);
  });
});

describe("settle", () => {
  it("reduces remaining by ACTUAL (not estimate) and releases the difference", async () => {
    await env.policy.checkEstimate(WS, CONV, 300);
    const r = await env.policy.reserve(WS, 300, asIdempotencyKey("k_settle"));
    expect(await env.policy.remaining(WS)).toBe(700); // 300 held

    await env.policy.settle(r, 120); // actual cheaper than estimate
    // reserved 300 released, settled 120 -> remaining = 1000 - 120
    expect(await env.policy.remaining(WS)).toBe(880);
  });

  it("attributes actual spend to the conversation's session", async () => {
    await env.policy.checkEstimate(WS, CONV, 40);
    const r = await env.policy.reserve(WS, 40, asIdempotencyKey("k_sess"));
    await env.policy.settle(r, 25);
    expect(await env.store.sessionSpent(CONV)).toBe(25);
  });

  it("settling at the full estimate leaves remaining unchanged from the held state", async () => {
    const r = await env.policy.reserve(WS, 200, asIdempotencyKey("k_full"));
    await env.policy.settle(r, 200);
    expect(await env.policy.remaining(WS)).toBe(800); // 200 spent
  });

  it("is an idempotent no-op when the reservation is already settled", async () => {
    const r = await env.policy.reserve(WS, 200, asIdempotencyKey("k_dbl"));
    await env.policy.settle(r, 50);
    await env.policy.settle(r, 50); // second settle must not double-count
    expect(await env.policy.remaining(WS)).toBe(950);
  });

  it("frees the held estimate so a subsequent reserve that previously failed now succeeds", async () => {
    const r = await env.policy.reserve(WS, 800, asIdempotencyKey("k_first"));
    // 800 held, 200 remaining -> a 400 reserve would fail right now
    const blocked = await env.policy.reserve(WS, 400, asIdempotencyKey("k_blocked")).catch((e) => e);
    expect(isOrthaError(blocked) && blocked.code).toBe(ErrorCode.BUDGET_EXCEEDED);

    await env.policy.settle(r, 100); // releases 700
    const ok = await env.policy.reserve(WS, 400, asIdempotencyKey("k_after"));
    expect(typeof ok).toBe("string");
  });
});

describe("refund", () => {
  it("restores remaining by releasing the entire hold", async () => {
    const r = await env.policy.reserve(WS, 350, asIdempotencyKey("k_refund"));
    expect(await env.policy.remaining(WS)).toBe(650);
    await env.policy.refund(r);
    expect(await env.policy.remaining(WS)).toBe(1000);
  });

  it("does not record any session spend", async () => {
    await env.policy.checkEstimate(WS, CONV, 350);
    const r = await env.policy.reserve(WS, 350, asIdempotencyKey("k_refund2"));
    await env.policy.refund(r);
    expect(await env.store.sessionSpent(CONV)).toBe(0);
  });

  it("is an idempotent no-op when called twice", async () => {
    const r = await env.policy.reserve(WS, 350, asIdempotencyKey("k_refund3"));
    await env.policy.refund(r);
    await env.policy.refund(r); // must not over-release
    expect(await env.policy.remaining(WS)).toBe(1000);
  });
});

describe("settings as a getter", () => {
  it("accepts a per-workspace getSettings function", async () => {
    const perWs: Record<string, BudgetSettings> = {
      ws_a: { sessionCapCents: 10, monthlyCapCents: 100, perCallWarnCents: 0 },
      ws_b: { sessionCapCents: 50, monthlyCapCents: 500, perCallWarnCents: 0 },
    };
    const get = (ws: WorkspaceId): BudgetSettings => perWs[ws] ?? SETTINGS;
    const store = new InMemorySpendStore((ws: WorkspaceId) => get(ws).monthlyCapCents);
    const policy = createBudgetPolicy({ store, settings: get });

    const wsA = asWorkspaceId("ws_a");
    const wsB = asWorkspaceId("ws_b");
    expect((await policy.checkEstimate(wsA, CONV, 20)).decision).toBe("permission_required"); // 20 > 10 session, <= 100 ws
    expect((await policy.checkEstimate(wsA, CONV, 200)).decision).toBe("denied"); // > 100 ws
    expect((await policy.checkEstimate(wsB, CONV, 20)).decision).toBe("ok"); // within both
  });
});

describe("full reserve -> settle -> reserve lifecycle accounting", () => {
  it("keeps remaining consistent across a mixed sequence", async () => {
    const key = (s: string) => asIdempotencyKey(s);
    const r1 = await env.policy.reserve(WS, 300, key("seq_1"));
    const r2 = await env.policy.reserve(WS, 200, key("seq_2"));
    expect(await env.policy.remaining(WS)).toBe(500); // 500 held

    await env.policy.settle(r1, 250); // spend 250, release 50
    expect(await env.policy.remaining(WS)).toBe(550); // 1000 - 250 settled - 200 reserved

    await env.policy.refund(r2); // release the other 200
    const remaining: Cents = await env.policy.remaining(WS);
    expect(remaining).toBe(750); // 1000 - 250 settled
  });
});
