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

// ── Real wire shapes, captured from live api.orthogonal.com probes (2026-05) ──
// These fixtures are verbatim-shaped responses from the production API. They are
// the regression guard for the live-mode mismatches found on 2026-05-26:
//   1. /search endpoints carry NO `price` (x402/USDC pricing via payableUrl).
//   2. /details nests the spec under `endpoint` with `price` as a NUMBER (dollars).
//   3. /run success is {success, priceCents:int, data, requestId}; errors are 4xx
//      with {success:false, error}.
// To refresh against the real API, run the gated smoke suite in client.live.test.ts.

const REAL_SEARCH = {
  success: true,
  results: [
    {
      id: "71c0d5e3-1d40-4bc5-9ad4-55ef42b17eed",
      name: "Context.dev",
      slug: "context-dev",
      baseUrl: "https://api.context.dev/v1",
      payableBaseUrl: "https://api.orth.sh/pay/context-dev",
      endpoints: [
        {
          id: "9c16c5de-a560-48e0-82c7-e3f08c33d462",
          path: "/web/scrape/markdown",
          method: "GET",
          description: "Scrapes the given URL, converts HTML to Markdown.",
          chain: "base",
          token: "USDC",
          isPayable: true,
          payableUrl: "https://x402.orth.sh/context-dev/web/scrape/markdown",
          verified: true,
          score: 0.9451,
        },
      ],
    },
  ],
  count: 1,
  apisCount: 1,
  prompt: "scrape a webpage to markdown",
  searchType: "semantic",
  responseTime: 1214,
};

const REAL_DETAILS = {
  success: true,
  api: { name: "Context.dev", slug: "context-dev", description: "Web scraping API.", baseUrl: "https://api.context.dev/v1", verified: true },
  endpoint: {
    path: "/web/scrape/markdown",
    method: "GET",
    description: "Scrapes the given URL, converts HTML to Markdown.",
    isPayable: true,
    price: 0.03,
    hasDynamicPricing: false,
    docsUrl: null,
    bodyType: null,
    pathParams: [],
    queryParams: [{ name: "url", type: "string", required: true, description: "Full URL to scrape" }],
    bodyParams: [],
  },
  usage: { runApi: 'POST /v1/run with {"api": "context-dev", "path": "/web/scrape/markdown", ...}', x402: "https://x402.orth.sh/context-dev/web/scrape/markdown" },
};

const REAL_RUN = {
  success: true,
  priceCents: 3,
  data: { success: true, markdown: "# Example Domain\n\nThis domain is for use in documentation examples.", url: "https://example.com" },
  requestId: "run_1779807017511_sbjbyrotkrc",
};

const REAL_RUN_404 = { success: false, error: "API nonexistent-xyz not found or not active" };

describe("real Orthogonal wire shapes", () => {
  it("search parses live results that omit per-endpoint price (x402 pricing)", async () => {
    const client = createOrthogonalClient({ getApiKey: apiKey, fetchImpl: async () => jsonResponse(REAL_SEARCH) });
    const results = await client.search({ prompt: "scrape a webpage to markdown" });
    expect(results[0]?.slug).toBe("context-dev");
    expect(results[0]?.endpoints[0]?.price).toBeUndefined();
    // No price in search => estimate is unknown until a /details lookup indexes it.
    const est = await client.estimateCost([{ api: "context-dev", path: "/web/scrape/markdown", expectedCalls: 1 }]);
    expect(est.hasUnknownPrices).toBe(true);
  });

  it("getDetails reads the nested endpoint, converts dollar price to cents, and indexes it", async () => {
    const client = createOrthogonalClient({ getApiKey: apiKey, fetchImpl: async () => jsonResponse(REAL_DETAILS) });
    const d = await client.getDetails("context-dev", "/web/scrape/markdown");
    expect(d.method).toBe("GET");
    expect(d.priceCents).toBe(3); // 0.03 dollars -> 3 cents
    expect(d.sideEffect).toBe("read"); // GET
    expect(d.verified).toBe(true);
    expect(d.inputSchema).not.toBeNull();
    // The details lookup indexed the price, so estimateCost can now price it.
    const est = await client.estimateCost([{ api: "context-dev", path: "/web/scrape/markdown", expectedCalls: 2 }]);
    expect(est.estimatedCents).toBe(6);
    expect(est.hasUnknownPrices).toBe(false);
  });

  it("getDetails marks a non-GET endpoint as write so the permission gate is cautious", async () => {
    const postDetails = {
      success: true,
      api: { slug: "serper-scrape", verified: true },
      endpoint: { path: "/", method: "POST", price: 0.02, bodyParams: [{ name: "url", type: "string", required: true }] },
    };
    const client = createOrthogonalClient({ getApiKey: apiKey, fetchImpl: async () => jsonResponse(postDetails) });
    const d = await client.getDetails("serper-scrape", "/");
    expect(d.sideEffect).toBe("write");
    expect(d.priceCents).toBe(2);
  });

  it("run validates the live success envelope", async () => {
    const client = createOrthogonalClient({ getApiKey: apiKey, fetchImpl: async () => jsonResponse(REAL_RUN) });
    const r = await client.run({ api: "context-dev", path: "/web/scrape/markdown", query: { url: "https://example.com" }, idempotencyKey: KEY });
    expect(r.success).toBe(true);
    expect(r.priceCents).toBe(3);
    expect(r.requestId).toBe("run_1779807017511_sbjbyrotkrc");
  });

  it("sends the idempotency-key + bearer auth headers on run", async () => {
    let headers: Record<string, string> = {};
    let calledUrl = "";
    const client = createOrthogonalClient({
      getApiKey: apiKey,
      fetchImpl: async (url, init) => {
        calledUrl = String(url);
        headers = (init?.headers ?? {}) as Record<string, string>;
        return jsonResponse(REAL_RUN);
      },
    });
    await client.run({ api: "context-dev", path: "/web/scrape/markdown", query: { url: "https://example.com" }, idempotencyKey: KEY });
    expect(headers["idempotency-key"]).toBe(KEY);
    expect(headers["authorization"]).toContain("Bearer ");
    expect(calledUrl).toContain("/run");
  });

  it("maps the live 404 run error to NOT_FOUND and does not retry", async () => {
    let calls = 0;
    const client = createOrthogonalClient({
      getApiKey: apiKey,
      fetchImpl: async () => {
        calls++;
        return jsonResponse(REAL_RUN_404, 404);
      },
    });
    await expect(client.run({ api: "nope", path: "/x", idempotencyKey: KEY })).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expect(calls).toBe(1);
  });
});
