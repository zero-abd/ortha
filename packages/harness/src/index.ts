// @ortha/harness — the only module that talks to Orthogonal. Implements the
// frozen OrthogonalClient seam with retry, timeout, circuit breaking, dedupe
// caching, zod validation, a price index, and a distillation helper.
export { createOrthogonalClient, type OrthogonalClientDeps } from "./client.js";
export { CircuitBreaker, type BreakerState, type CircuitBreakerOptions } from "./breaker.js";
export { DedupeCache, requestKey, type DedupeCacheOptions } from "./cache.js";
export { distill, type Distilled } from "./distill.js";
export { createWebClient, type WebClientDeps } from "./web.js";
