import {
  asRequestId,
  ErrorCode,
  OrthaError,
  RunResponseSchema,
  SearchResponseSchema,
  type Cents,
  type CostEstimate,
  type CostPlanStep,
  type OrthogonalClient,
  type RunInput,
  type RunResult,
  type SearchInput,
  type SideEffectClass,
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
  const priceKey = (api: string, path: string): string => `${api} ${path}`;

  async function post(pathname: string, payload: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    const apiKey = await deps.getApiKey();
    let lastErr: OrthaError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
        if (err.retryable && attempt < maxRetries) {
          lastErr = err;
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof OrthaError) {
          if (e.retryable && attempt < maxRetries) {
            lastErr = e;
            await sleep(backoffMs(attempt));
            continue;
          }
          throw e;
        }
        // Network failure or abort (timeout).
        const aborted = e instanceof Error && e.name === "AbortError";
        const err = new OrthaError(
          aborted ? ErrorCode.TIMEOUT : ErrorCode.PROVIDER_DOWN,
          aborted ? `request timed out after ${timeoutMs}ms` : `network error`,
          { retryable: true, cause: e },
        );
        if (attempt < maxRetries) {
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
      const raw = (await post("/details", { api, path })) as Record<string, unknown>;
      const priceStr = typeof raw["price"] === "string" ? (raw["price"] as string) : null;
      const cents = priceStr ? priceToCents(priceStr) : priceIndex.get(priceKey(api, path)) ?? 0;
      if (priceStr) {
        const c = priceToCents(priceStr);
        if (c !== null) priceIndex.set(priceKey(api, path), c);
      }
      return {
        api,
        path,
        method: typeof raw["method"] === "string" ? (raw["method"] as string) : "POST",
        inputSchema: raw["inputSchema"] ?? raw["parameters"] ?? null,
        outputSchema: raw["outputSchema"] ?? raw["responseSchema"] ?? null,
        priceCents: cents ?? 0,
        verified: raw["verified"] === true,
        sideEffect: normalizeSideEffect(raw["sideEffect"] ?? raw["method"]),
      };
    },

    async run(input: RunInput): Promise<RunResult> {
      if (!breaker.canRequest(input.api)) {
        throw new OrthaError(ErrorCode.PROVIDER_DOWN, `circuit open for ${input.api}`, {
          providerSlug: input.api,
          retryable: true,
        });
      }
      const key = requestKey({ api: input.api, path: input.path, body: input.body, query: input.query });
      try {
        const result = await cache.run<RunResult>(
          key,
          async () => {
            const raw = await post(
              "/run",
              { api: input.api, path: input.path, body: input.body, query: input.query },
              { "idempotency-key": input.idempotencyKey },
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
      const breakdown = plan.map((s) => {
        const unit = priceIndex.get(priceKey(s.api, s.path));
        if (unit === undefined) hasUnknownPrices = true;
        return { api: s.api, path: s.path, cents: (unit ?? 0) * s.expectedCalls };
      });
      return {
        estimatedCents: breakdown.reduce((a, b) => a + b.cents, 0),
        breakdown,
        hasUnknownPrices,
      };
    },
  };
}

async function httpError(res: Response): Promise<OrthaError> {
  let detail = "";
  try {
    detail = await res.text();
  } catch {
    /* ignore */
  }
  switch (res.status) {
    case 400:
      return new OrthaError(ErrorCode.BAD_REQUEST, `bad request: ${detail}`);
    case 401:
      return new OrthaError(ErrorCode.AUTH, `unauthorized: ${detail}`);
    case 402:
      return new OrthaError(ErrorCode.INSUFFICIENT_CREDITS, `insufficient credits: ${detail}`);
    case 404:
      return new OrthaError(ErrorCode.NOT_FOUND, `not found: ${detail}`);
    default:
      if (res.status >= 500) {
        return new OrthaError(ErrorCode.PROVIDER_DOWN, `upstream ${res.status}: ${detail}`, { retryable: true });
      }
      return new OrthaError(ErrorCode.BAD_REQUEST, `unexpected ${res.status}: ${detail}`);
  }
}

function priceToCents(price: string): Cents | null {
  const dollars = Number.parseFloat(price);
  if (Number.isNaN(dollars)) return null;
  return Math.round(dollars * 100);
}

function normalizeSideEffect(v: unknown): SideEffectClass {
  if (v === "read" || v === "write") return v;
  if (typeof v === "string" && v.toUpperCase() === "GET") return "read";
  return "unknown";
}

const backoffMs = (attempt: number): number => Math.min(2_000, 250 * 2 ** attempt);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
