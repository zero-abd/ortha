import { asIdempotencyKey, ErrorCode, isOrthaError } from "@ortha/contracts";
import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/breaker.js";
import { distill } from "../src/distill.js";
import { createOrthogonalClient } from "../src/client.js";

const KEY = asIdempotencyKey("idem_1");
const apiKey = async (): Promise<string> => "orth_live_test";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SEARCH_BODY = {
  success: true,
  results: [
    {
      name: "Apollo.io",
      slug: "apollo",
      endpoints: [
        { id: "e1", path: "/v1/people/match", method: "POST", description: "enrich", price: "0.03", verified: true, score: 0.95 },
      ],
    },
  ],
  count: 1,
  apisCount: 1,
};

const RUN_BODY = { success: true, priceCents: 3, data: { name: "Patrick Collison" }, requestId: "run_abc" };

describe("search + estimateCost", () => {
  it("parses search and prices a plan from the indexed prices", async () => {
    const client = createOrthogonalClient({ getApiKey: apiKey, fetchImpl: async () => jsonResponse(SEARCH_BODY) });
    const results = await client.search({ prompt: "enrich" });
    expect(results[0]?.slug).toBe("apollo");
    const est = await client.estimateCost([{ api: "apollo", path: "/v1/people/match", expectedCalls: 2 }]);
    expect(est.estimatedCents).toBe(6); // 0.03 * 100 * 2
    expect(est.hasUnknownPrices).toBe(false);
  });

  it("flags unknown prices for un-indexed endpoints", async () => {
    const client = createOrthogonalClient({ getApiKey: apiKey, fetchImpl: async () => jsonResponse(SEARCH_BODY) });
    const est = await client.estimateCost([{ api: "mystery", path: "/x", expectedCalls: 1 }]);
    expect(est.hasUnknownPrices).toBe(true);
    expect(est.estimatedCents).toBe(0);
  });
});

describe("run", () => {
  it("returns a validated RunResult on success", async () => {
    const client = createOrthogonalClient({ getApiKey: apiKey, fetchImpl: async () => jsonResponse(RUN_BODY) });
    const r = await client.run({ api: "apollo", path: "/v1/people/match", body: { email: "a@b.com" }, idempotencyKey: KEY });
    expect(r.priceCents).toBe(3);
    expect(r.requestId).toBe("run_abc");
  });

  it("maps 402 to INSUFFICIENT_CREDITS and does not retry", async () => {
    let calls = 0;
    const client = createOrthogonalClient({
      getApiKey: apiKey,
      fetchImpl: async () => {
        calls++;
        return jsonResponse({ error: "no credits" }, 402);
      },
    });
    await expect(client.run({ api: "apollo", path: "/p", idempotencyKey: KEY })).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_CREDITS,
    });
    expect(calls).toBe(1); // 4xx is not retried
  });

  it("retries 5xx then throws PROVIDER_DOWN", async () => {
    let calls = 0;
    const client = createOrthogonalClient({
      getApiKey: apiKey,
      maxRetries: 1,
      fetchImpl: async () => {
        calls++;
        return jsonResponse({ error: "boom" }, 503);
      },
    });
    const err = await client.run({ api: "apollo", path: "/p", idempotencyKey: KEY }).catch((e) => e);
    expect(isOrthaError(err) && err.code).toBe(ErrorCode.PROVIDER_DOWN);
    expect(calls).toBe(2); // initial + 1 retry
  });

  it("maps an aborted/timed-out fetch to TIMEOUT", async () => {
    const client = createOrthogonalClient({
      getApiKey: apiKey,
      maxRetries: 0,
      fetchImpl: async () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      },
    });
    await expect(client.run({ api: "apollo", path: "/p", idempotencyKey: KEY })).rejects.toMatchObject({
      code: ErrorCode.TIMEOUT,
    });
  });

  it("dedupes concurrent identical calls into one upstream request", async () => {
    let calls = 0;
    const client = createOrthogonalClient({
      getApiKey: apiKey,
      fetchImpl: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return jsonResponse(RUN_BODY);
      },
    });
    const input = { api: "apollo", path: "/p", body: { email: "a@b.com" }, idempotencyKey: KEY };
    const [a, b] = await Promise.all([client.run(input), client.run(input)]);
    expect(calls).toBe(1);
    expect(a.requestId).toBe(b.requestId);
  });

  it("opens the circuit after the failure threshold and short-circuits", async () => {
    let calls = 0;
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
    const client = createOrthogonalClient({
      getApiKey: apiKey,
      maxRetries: 0,
      breaker,
      fetchImpl: async () => {
        calls++;
        return jsonResponse({ error: "boom" }, 503);
      },
    });
    await client.run({ api: "apollo", path: "/p", idempotencyKey: KEY }).catch(() => {});
    await client.run({ api: "apollo", path: "/p", idempotencyKey: KEY }).catch(() => {});
    // Circuit now open — third call must not hit fetch.
    const err = await client.run({ api: "apollo", path: "/p", idempotencyKey: KEY }).catch((e) => e);
    expect(calls).toBe(2);
    expect(breaker.state("apollo")).toBe("open");
    expect(isOrthaError(err) && err.code).toBe(ErrorCode.PROVIDER_DOWN);
  });
});

describe("distill", () => {
  it("passes small payloads through untouched", () => {
    const d = distill({ a: 1 });
    expect(d.truncated).toBe(false);
  });

  it("truncates large payloads and surfaces top-level scalars", () => {
    const big = { name: "Stripe", ceo: "Patrick", blob: "x".repeat(5000) };
    const d = distill(big, 200);
    expect(d.truncated).toBe(true);
    expect(d.rawBytes).toBeGreaterThan(200);
    expect(d.summary).toContain("name: Stripe");
  });
});
