# Orthogonal Harness — Limitations & Handling Plan (CEO synthesis)

Synthesis of five parallel live-API probes (web scraping, web search/news, enrichment,
social/contacts, finance-maps-data). Each category has its own file in this folder with
the catalog table, measured sizes, and detailed reasoning. This is the consolidated,
prioritized plan to make live mode production-real.

**How this was produced:** 5 agents hit the real `api.orthogonal.com` gateway, using FREE
`/search` + `/details` for breadth and minimal PAID `/run` calls to measure real response
sizes. Total real spend across all five: **~74.5¢**.

## Catalog snapshot

- **~40–50 unique provider APIs** across the categories (with cross-category overlap:
  tomba, peopledatalabs, contactout, crustdata, serper, context-dev, tavily, scrapegraphai,
  brand-dev appear in 2+). Each exposes multiple endpoints — well over 100 endpoints total.
- **Price range:** $0.002 (serper search) → $0.35 (PeopleDataLabs person enrich). Most
  cluster $0.002–$0.03.
- **Response-size range:** 94 bytes (a single crypto price) → **412 KB** (tavily 20 results
  with raw content) → **megabytes** (a 500-page crawl). Size is driven by *result count /
  content inclusion*, not the endpoint identity: the same dome endpoint went 94 B → 7 KB
  (75×) just by widening a time range.

## Cross-cutting limitations (ranked)

| # | Severity | Limitation | Evidence | Source |
|---|---|---|---|---|
| L1 | **P0** | `distill()` keeps only top-level **scalars** over 800 chars, so the actual answer (always an **array** or under an **envelope key**) is dropped or emptied | serper→`credits:1`; seltz→empty→raw slice; dome 100-pt history→`total:100`; brand-dev depth-6→`status:ok` | all 5 |
| L2 | **P0** | Raw store is an **unbounded, in-memory, per-turn** `Map` (`mapKvPort`) — OOM risk on 173 KB–412 KB payloads, no size cap, and `expand_result` can't reach a prior turn | tavily 412 KB; wiki HTML 173 KB | scraping, search |
| L3 | P1 | `hasDynamicPricing` is **dropped** before the budget gate, so estimates silently understate spend | precip billed **2.6× advertised**; tavily/scrapegraphai/contactout/pdl dynamic | search, data, social |
| L4 | P1 | Async / long-ops vs the **30s buffered-fetch timeout** → request **aborts but still charges** (no streaming on Workers, no paid retry) | crawls "1–10 min"; tavily `/research`, happenstance, nyne are submit→poll | scraping, search, social |
| L5 | P1 | `side_effect` permission gate is **dead code** (loop only emits `kind:"cost"`); the method-only heuristic also mislabels read-only POST lookups as "write" | `loop.ts` never emits `kind:"side_effect"`; entire social category is read-only yet mostly POST | social |
| L6 | P1 | Error handling gaps: `httpError()` has **no 422 case**; structured upstream error body discarded; can't distinguish **failed-unbilled vs failed-maybe-billed** | enrichment 422s "unexpected"; bad-input 4xx returned unbilled but indistinguishable | enrichment |
| L7 | P2 | Price index keyed by `slug+path` **collides** when one path has two methods | dual-method endpoints alias | social |
| L8 | P2 | Gateway requires GET query params as **strings**; numbers rejected → wasted non-retried paid call | dome `start_time`/`limit` numeric → rejected | data |
| L9 | P2 | No **pre-flight required-param validation**, though `/details` already returns `required` flags | missing email/domain → upstream 4xx after round-trip | enrichment |

## The central fix — structure-aware distillation (L1)

Every category breaks the same way: the useful content is an array or nested under an
envelope, and the scalar-only fallback skips both. Replace `distill()`'s fallback with a
shape-aware reducer that bounds size *and* keeps the answer. Target shape:

```
distill(data, { maxChars=800, previewItems=5, snippetChars=160 }) ->
  { kind, summary, scalars?, count?, preview?, rawBytes, truncated, rawHandle }

1. Unwrap single-child envelopes: descend through a lone object/array value under a
   known wrapper key (data, output, outputs, result, results, brand), recording the path.
2. Find the primary collection: first array among [results, organic, documents, news,
   items, data, hits, places, candles, companies, people], OR the bare root if it's an array.
3. List -> { kind:"list", count:N, preview:[reduceItem(x) x previewItems], scalars:{answer,
   query, total, ...}, rawHandle }. reduceItem keeps title/name + url/link + snippet
   trimmed to snippetChars. (Preserves answer-engine `answer` AND citations — both are gold.)
4. Time-series/array-of-numbers -> { kind:"series", count, first, last, min, max, mean,
   sample:[...] } (domain reducer).
5. Object (no collection) -> keep top-level scalars + recurse one level into the largest
   nested object; head+tail slice long text fields.
6. Scalar/string root -> head+tail slice to maxChars.
Always set rawBytes, truncated, rawHandle so expand_result can fetch the full body.
```

This is one focused rewrite of `packages/harness/src/distill.ts` plus tests using the
fixtures the probes captured. It fixes the entire catalog at once.

## Prioritized roadmap

### P0 — without these, live mode returns garbage summaries
- **P0-1 Structure-aware distillation** (spec above). Files: `packages/harness/src/distill.ts` (+ tests). CC: ~30 min.
- **P0-2 Durable, size-capped raw store + cross-turn `expand_result`.** Swap the per-turn `mapKvPort` for a DO-SQLite-backed `KvPort` (raw lives with the conversation); add a byte cap (e.g. refuse/spill > ~256 KB, record "N bytes dropped"); paginate `expand_result`. Files: `apps/edge/src/ports.ts`, `packages/context/src/store.ts`, a new DO-SQLite KvPort. CC: ~40 min.

### P1 — cost-safety + correctness
- **P1-1 Surface `hasDynamicPricing`** on `ToolDetails` + `CostEstimate.breakdown`; treat a dynamic price as a **floor / needs-permission** (use the `dryRun` flag where providers expose it). Files: `packages/contracts/src/orthogonal.ts`, `packages/harness/src/client.ts`, budget gate.
- **P1-2 Async/long-op handling.** For now, keep crawl/`/research` submit→poll endpoints **out of the auto-callable set** (or add a submit→poll helper with a longer budget); never let a paid long-op silently abort-and-charge at 30s.
- **P1-3 Wire the side-effect gate + better classification.** Emit `kind:"side_effect"` from the loop for true writes; replace method-only with verb/path/description heuristic (default POST=read; gate only genuine send/post/mutate). Files: `packages/agent/src/loop.ts`, `packages/harness/src/client.ts`.
- **P1-4 Error mapping.** Add 422 → `BAD_REQUEST`/validation; lift the structured upstream `{error|errors}` into the message; add a billed-vs-unbilled signal so callers know whether a refund/retry is safe. Files: `packages/harness/src/client.ts`.

### P2 — polish
- **P2-1** Key the price index by `method+path` (not `slug+path`).
- **P2-2** Coerce query params to the declared `/details` schema type (numbers → strings for GET).
- **P2-3** Pre-flight required-param validation in `run()` using `inputSchema.required` before the paid call.

## Context-window strategy (the explicit ask)

The agent's LLM context is protected by the **distill + handle** pattern: only the bounded
structured summary (answer + count + top-N preview, or series stats) enters the prompt; the
full body stays in the durable raw store, fetched on demand via `expand_result`. With P0-1 +
P0-2, a 412 KB payload becomes a ~bounded summary in context, and the model can pull more
only when it explicitly needs it — no unbounded growth regardless of tool output.

## NOT in scope (yet)
- Server-side idempotency / a persisted call journal for resume-safety (separate from this
  pass; flagged earlier). The double-charge-on-retry guard already shipped.
- Streaming tool responses (Workers buffer; revisit only if a tool truly needs it).
- Auto-handling every async job type — start by excluding them, model later.

See per-category detail: [scraping](scraping.md), [search-news](search-news.md),
[enrichment](enrichment.md), [social-contacts](social-contacts.md),
[data-finance-maps](data-finance-maps.md).
