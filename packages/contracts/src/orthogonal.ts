import { z } from "zod";
import type { Cents } from "./domain.js";
import type { IdempotencyKey, RequestId } from "./ids.js";

// ── Wire schemas (validate every response from api.orthogonal.com) ───────────

/** Risk class for an endpoint. `unknown` until verified; governed accordingly. */
export type SideEffectClass = "read" | "write" | "unknown";

export const EndpointSchema = z.object({
  id: z.string(),
  path: z.string(),
  method: z.string(),
  description: z.string(),
  /** Cost per call as a decimal-string of dollars, e.g. "0.03". */
  price: z.string(),
  isPayable: z.boolean().optional(),
  verified: z.boolean().optional(),
  score: z.number().optional(),
});
export type Endpoint = z.infer<typeof EndpointSchema>;

export const ToolApiSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  slug: z.string(),
  baseUrl: z.string().optional(),
  endpoints: z.array(EndpointSchema),
});
export type ToolApi = z.infer<typeof ToolApiSchema>;

export const SearchResponseSchema = z.object({
  success: z.boolean(),
  results: z.array(ToolApiSchema),
  count: z.number().optional(),
  apisCount: z.number().optional(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const RunResponseSchema = z.object({
  success: z.boolean(),
  /** Cost in cents (100 = $1). Authoritative actual cost of the call. */
  priceCents: z.number(),
  data: z.unknown(),
  requestId: z.string(),
});
export type RunResponse = z.infer<typeof RunResponseSchema>;

// ── Client-facing types ──────────────────────────────────────────────────────

export interface SearchInput {
  readonly prompt: string;
  readonly limit?: number;
}

export interface RunInput {
  readonly api: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly query?: Record<string, string>;
  /**
   * Required. Makes the call replay-safe: the harness journals this key before
   * executing and refuses to re-charge a key already settled.
   */
  readonly idempotencyKey: IdempotencyKey;
}

export interface RunResult {
  readonly success: boolean;
  readonly priceCents: Cents;
  readonly data: unknown;
  readonly requestId: RequestId;
}

/** Full parameter + response spec for an endpoint (from /v1/details). */
export interface ToolDetails {
  readonly api: string;
  readonly path: string;
  readonly method: string;
  /** JSON-schema-ish input spec. `null` if Orthogonal returns no typed schema. */
  readonly inputSchema: unknown | null;
  readonly outputSchema: unknown | null;
  readonly priceCents: Cents;
  readonly verified: boolean;
  readonly sideEffect: SideEffectClass;
}

export interface CostPlanStep {
  readonly api: string;
  readonly path: string;
  readonly expectedCalls: number;
}

export interface CostEstimate {
  readonly estimatedCents: Cents;
  readonly breakdown: readonly { api: string; path: string; cents: Cents }[];
  /** True if any step's price was unknown and assumed; estimate is a lower bound. */
  readonly hasUnknownPrices: boolean;
}

/**
 * The only seam that talks to Orthogonal. Implementations own retry, timeout,
 * per-provider circuit breaking, dedupe caching, response distillation, and the
 * idempotency journal. See packages/harness.
 */
export interface OrthogonalClient {
  search(input: SearchInput): Promise<readonly ToolApi[]>;
  getDetails(api: string, path: string): Promise<ToolDetails>;
  /** Executes a tool call. Idempotent per `idempotencyKey`. */
  run(input: RunInput): Promise<RunResult>;
  /** Prices a planned sequence of calls before any spend, from the price index. */
  estimateCost(plan: readonly CostPlanStep[]): Promise<CostEstimate>;
}
