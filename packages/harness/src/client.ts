import {
  asRequestId,
  ErrorCode,
  OrthaError,
  DetailsResponseSchema,
  RunResponseSchema,
  SearchResponseSchema,
  type Cents,
  type CostEstimate,
  type CostPlanStep,
  type OrthogonalClient,
  type RunInput,
  type RunResult,
  type SearchInput,
  type ToolApi,
  type ToolDetails,
} from "@ortha/contracts";
import { CircuitBreaker } from "./breaker.js";
import { DedupeCache, requestKey } from "./cache.js";

export interface OrthogonalClientDeps {
  /** Returns the workspace's decrypted Orthogonal key (from KeyVault). */
  getApiKey: () => Promise<string>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  now?: () => number;
  breaker?: CircuitBreaker;
  cache?: DedupeCache;
  /** Shared price index (slug+path → cents), so estimateCost is accurate after search. */
  priceIndex?: Map<string, Cents>;
  /**
   * Shared dynamic-pricing index (slug+path → bool). A dynamic price makes the
   * estimate a floor, so the budget gate forces explicit approval. Populated by
   * getDetails (the only source that returns `hasDynamicPricing`).
   */
  dynamicIndex?: Map<string, boolean>;
}

const DEFAULT_BASE = "https://api.orthogonal.com/v1";

export function createOrthogonalClient(deps: OrthogonalClientDeps): OrthogonalClient {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const baseUrl = (deps.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const maxRetries = deps.maxRetries ?? 2;
  const nowOpt = deps.now ? { now: deps.now } : {};
  const breaker = deps.breaker ?? new CircuitBreaker(nowOpt);
  const cache = deps.cache ?? new DedupeCache(nowOpt);
  const priceIndex = deps.priceIndex ?? new Map<string, Cents>();
  const dynamicIndex = deps.dynamicIndex ?? new Map<string, boolean>();
  // Required-param schema indexed by getDetails, consulted by run() for a free
  // pre-flight check so a missing required param never becomes a wasted paid call.
  const schemaIndex = new Map<string, RequiredParams>();
  const priceKey = (api: string, path: string): string => `${api} ${path}`;

  // `retries` defaults to the client-wide maxRetries. Paid /run passes 0: the
  // Orthogonal server does NOT honor idempotency-key (verified against the live
  // API — identical keys produce distinct requestIds and charge twice), so a
  // retry after an ambiguous timeout/5xx would double-charge. Reads stay retryable.
  async function post(
    pathname: string,
    payload: unknown,
    extraHeaders: Record<string, string> = {},
    retries: number = maxRetries,
  ): Promise<unknown> {
    const apiKey = await deps.getApiKey();
    let lastErr: OrthaError | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl}${pathname}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            ...extraHeaders,
          },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (res.ok) return await res.json();
        const err = await httpError(res);
        if (err.retryable && attempt < retries) {
          lastErr = err;
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof OrthaError) {
          if (e.retryable && attempt < retries) {
            lastErr = e;
            await sleep(backoffMs(attempt));
            continue;
          }
          throw e;
        }
        // Network failure or abort (timeout). A timeout means the request was already
        // in flight — the upstream may have executed and charged (ambiguous). A connect
        // failure means it never landed, so it was not billed.
        const aborted = e instanceof Error && e.name === "AbortError";
        const err = new OrthaError(
          aborted ? ErrorCode.TIMEOUT : ErrorCode.PROVIDER_DOWN,
          aborted ? `request timed out after ${timeoutMs}ms` : `network error`,
          { retryable: true, cause: e, maybeBilled: aborted },
        );
        if (attempt < retries) {
          lastErr = err;
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new OrthaError(ErrorCode.PROVIDER_DOWN, "exhausted retries", { retryable: true });
  }

  function indexPrices(apis: readonly ToolApi[]): void {
    for (const api of apis) {
      for (const ep of api.endpoints) {
        // Live search results no longer include a price; only index when present.
        if (ep.price === undefined) continue;
        const cents = priceToCents(ep.price);
        if (cents !== null) priceIndex.set(priceKey(api.slug, ep.path), cents);
      }
    }
  }

  return {
    async search(input: SearchInput): Promise<readonly ToolApi[]> {
      const raw = await post("/search", { prompt: input.prompt, limit: input.limit ?? 10 });
      const parsed = SearchResponseSchema.parse(raw);
      indexPrices(parsed.results);
      return parsed.results;
    },

    async getDetails(api: string, path: string): Promise<ToolDetails> {
      // Real shape: the endpoint spec is nested under `endpoint`, `price` is a
      // numeric dollar amount, and params are split across query/body/path.
      const parsed = DetailsResponseSchema.parse(await post("/details", { api, path }));
      const ep = parsed.endpoint;
      // Price comes as dollars (e.g. 0.03). Prefer it; fall back to any indexed price.
      const cents = ep.price !== undefined ? Math.round(ep.price * 100) : priceIndex.get(priceKey(api, path)) ?? 0;
      // Index it so estimateCost can price this endpoint after a details lookup.
      if (ep.price !== undefined) priceIndex.set(priceKey(api, path), cents);
      // Dynamic pricing makes `cents` a floor, not the exact charge. Index it so a later
      // estimateCost (e.g. at run-time) knows to force an explicit spend approval.
      const hasDynamicPricing = ep.hasDynamicPricing === true;
      dynamicIndex.set(priceKey(api, path), hasDynamicPricing);
      const inputSchema = ep.bodyParams?.length || ep.queryParams?.length || ep.pathParams?.length
        ? { query: ep.queryParams ?? [], body: ep.bodyParams ?? [], path: ep.pathParams ?? [] }
        : null;
      // Index the required-param names so run() can pre-flight a paid call for free.
      schemaIndex.set(priceKey(api, path), {
        query: requiredParamNames(ep.queryParams),
        body: requiredParamNames(ep.bodyParams),
        path: requiredParamNames(ep.pathParams),
      });
      return {
        api,
        path,
        method: ep.method,
        inputSchema,
        outputSchema: null,
        priceCents: cents,
        hasDynamicPricing,
        verified: parsed.api?.verified === true,
        // GET is a read; anything else may mutate — treat as write so the gate is cautious.
        sideEffect: ep.method.toUpperCase() === "GET" ? "read" : "write",
      };
    },

    async run(input: RunInput): Promise<RunResult> {
      // Pre-flight (free): reject a missing required param before the paid call, using
      // the schema a prior getDetails indexed. Un-inspected endpoints skip validation.
      const missing = missingRequiredParams(schemaIndex.get(priceKey(input.api, input.path)), input);
      if (missing.length > 0) {
        throw new OrthaError(ErrorCode.BAD_REQUEST, `missing required parameter(s): ${missing.join(", ")}`, { maybeBilled: false });
      }
      // The gateway requires query values as strings; a numeric value is rejected as a
      // wasted, non-retried paid call (L8). Coerce defensively, regardless of caller.
      const query = stringifyQuery(input.query);
      if (!breaker.canRequest(input.api)) {
        throw new OrthaError(ErrorCode.PROVIDER_DOWN, `circuit open for ${input.api}`, {
          providerSlug: input.api,
          retryable: true,
        });
      }
      const key = requestKey({ api: input.api, path: input.path, body: input.body, query });
      try {
        const result = await cache.run<RunResult>(
          key,
          async () => {
            const raw = await post(
              "/run",
              { api: input.api, path: input.path, body: input.body, query },
              { "idempotency-key": input.idempotencyKey },
              0, // paid mutation: never auto-retry (server doesn't dedupe → would double-charge)
            );
            const parsed = RunResponseSchema.parse(raw);
            return {
              success: parsed.success,
              priceCents: parsed.priceCents,
              data: parsed.data,
              requestId: asRequestId(parsed.requestId),
            };
          },
          (v) => v.success,
        );
        breaker.recordSuccess(input.api);
        return result;
      } catch (e) {
        if (e instanceof OrthaError && (e.code === ErrorCode.PROVIDER_DOWN || e.code === ErrorCode.TIMEOUT)) {
          breaker.recordFailure(input.api);
        }
        throw e;
      }
    },

    async estimateCost(plan: readonly CostPlanStep[]): Promise<CostEstimate> {
      let hasUnknownPrices = false;
      let hasDynamicPricing = false;
      const breakdown = plan.map((s) => {
        const unit = priceIndex.get(priceKey(s.api, s.path));
        if (unit === undefined) hasUnknownPrices = true;
        const dynamic = dynamicIndex.get(priceKey(s.api, s.path)) ?? false;
        if (dynamic) hasDynamicPricing = true;
        return { api: s.api, path: s.path, cents: (unit ?? 0) * s.expectedCalls, dynamic };
      });
      return {
        estimatedCents: breakdown.reduce((a, b) => a + b.cents, 0),
        breakdown,
        hasUnknownPrices,
        hasDynamicPricing,
      };
    },
  };
}

async function httpError(res: Response): Promise<OrthaError> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  const detail = liftErrorDetail(body);
  switch (res.status) {
    // 400 and 422 are both input-validation failures. The gateway rejected the
    // request before running the paid provider call, so the call was NOT billed —
    // safe to fix the input and retry.
    case 400:
    case 422:
      return new OrthaError(ErrorCode.BAD_REQUEST, `invalid request (${res.status}): ${detail}`, { maybeBilled: false });
    case 401:
      return new OrthaError(ErrorCode.AUTH, `unauthorized: ${detail}`, { maybeBilled: false });
    case 402:
      return new OrthaError(ErrorCode.INSUFFICIENT_CREDITS, `insufficient credits: ${detail}`, { maybeBilled: false });
    case 404:
      return new OrthaError(ErrorCode.NOT_FOUND, `not found: ${detail}`, { maybeBilled: false });
    default:
      if (res.status >= 500) {
        // The request reached the upstream; the paid call MAY have executed before the
        // 5xx. Retryable for free reads; for a paid run the outcome is ambiguous.
        return new OrthaError(ErrorCode.PROVIDER_DOWN, `upstream ${res.status}: ${detail}`, { retryable: true, maybeBilled: true });
      }
      return new OrthaError(ErrorCode.BAD_REQUEST, `unexpected ${res.status}: ${detail}`, { maybeBilled: false });
  }
}

/**
 * Pulls a human-readable message out of an upstream error body. Orthogonal returns
 * `{ success:false, error:"..." }` (or `{ errors:[...] }` / `{ message:"..." }`).
 * Falls back to the raw text when the body isn't structured JSON.
 */
function liftErrorDetail(body: string): string {
  const raw = body.trim();
  if (!raw) return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj["error"] === "string") return obj["error"];
      if (typeof obj["message"] === "string") return obj["message"];
      const errs = obj["errors"];
      if (Array.isArray(errs)) return errs.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("; ");
      if (errs && typeof errs === "object") return JSON.stringify(errs);
    }
  } catch {
    /* not JSON — fall through to raw */
  }
  return raw;
}

interface RequiredParams {
  readonly query: readonly string[];
  readonly body: readonly string[];
  readonly path: readonly string[];
}

/** Coerce all query values to strings — the gateway rejects numeric GET query params (L8). */
function stringifyQuery(query: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!query) return undefined;
  const entries = Object.entries(query as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) out[k] = typeof v === "string" ? v : String(v);
  return out;
}

/** Names of params flagged `required:true` in a /details param list. */
function requiredParamNames(params: readonly unknown[] | undefined): string[] {
  if (!params) return [];
  const out: string[] = [];
  for (const p of params) {
    if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      if (o["required"] === true && typeof o["name"] === "string") out.push(o["name"]);
    }
  }
  return out;
}

/** Required params absent from a run input, as `location.name` labels. Empty when valid. */
function missingRequiredParams(schema: RequiredParams | undefined, input: RunInput): string[] {
  if (!schema) return []; // endpoint not inspected via getDetails → can't validate, don't block
  const missing: string[] = [];
  for (const name of schema.query) {
    const v = input.query?.[name];
    if (v === undefined || v === "") missing.push(`query.${name}`);
  }
  for (const name of schema.body) {
    if (input.body?.[name] === undefined) missing.push(`body.${name}`);
  }
  for (const name of schema.path) {
    // A path param is satisfied either by being substituted into the path already,
    // or by being supplied in body/query for the gateway to substitute.
    const stillTemplated = input.path.includes(`{${name}}`) || input.path.includes(`:${name}`);
    const provided = input.body?.[name] !== undefined || input.query?.[name] !== undefined;
    if (stillTemplated && !provided) missing.push(`path.${name}`);
  }
  return missing;
}

function priceToCents(price: string): Cents | null {
  const dollars = Number.parseFloat(price);
  if (Number.isNaN(dollars)) return null;
  return Math.round(dollars * 100);
}

const backoffMs = (attempt: number): number => Math.min(2_000, 250 * 2 ** attempt);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
