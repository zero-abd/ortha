# Harness plan: Web Scraping, Crawling & Screenshots

Live probe of the Orthogonal gateway (`https://api.orthogonal.com/v1`) for the
scraping/crawling/screenshot theme, evaluated against our harness
(`packages/harness/src/{distill,client}.ts`, `apps/edge/src/ports.ts`) and
Cloudflare Worker limits. Probed 2026-05-26. Total paid spend: **~28¢** (cap $0.40).

## 1. Catalog

8 unique APIs / 25 endpoints surfaced across 5 free `/search` queries. Representative
endpoints (price from free `/details`; raw bytes = `data` payload measured via paid `/run`):

| API | endpoint | method | price | dynamic? | raw bytes (measured) |
|---|---|---|---|---|---|
| scrapegraphai | `/api/scrape` | POST | $0.005 | yes | 302 (example.com) / **64,752** (wiki) |
| serper-scrape | `/` | POST | $0.02 | no | 194 (example.com, text-only)* |
| riveter | `/v1/scrape` | POST | $0.01 | yes | not run (dynamic; has `dryRun`) |
| tavily | `/extract` | POST | $0.01 | yes | not run (dynamic; multi-URL `urls[]`) |
| context-dev | `/web/scrape/markdown` | GET | $0.03 | no | 229 (example.com) / **64,969** (wiki) |
| context-dev | `/web/scrape/html` | GET | $0.03 | no | **172,982** (wiki, raw HTML) |
| context-dev | `/web/crawl` | POST | $0.03/page | no | 403 (example.com, 1 page); cap 500 pages |
| context-dev | `/web/scrape/sitemap` | GET | $0.03 | no | not run (returns up to 100k URLs) |
| context-dev | `/web/scrape/images` | GET | $0.03 | no | not run |
| brand-dev | `/v1/brand/screenshot` | GET | $0.03 | no | 198 (returns CDN URL, not bytes) |
| scrapegraphai | `/api/crawl` | POST | dynamic | yes | not run (async, depth+page limits) |
| scrapegraphai | `/api/extract` | POST | dynamic | yes | not run (LLM extraction) |
| tavily | `/crawl` | POST | dynamic | yes | not run (parallel graph crawl) |
| olostep | `/v1/crawls` | POST | — | — | not run (**async, 1-10 min**, poll via `/v1/crawls/{id}`) |
| notte | `/scrape_from_html`, `/sessions/.../screenshot` | POST | — | — | not run (session-based browser) |

\* serper text-only `194 B`; with `includeMarkdown`/`includeHtml` it grows like the others.

**Response-size range:** ~190 bytes (trivial page / screenshot-URL) → **~173 KB** (raw
HTML of one Wikipedia article). A bounded markdown scrape of one content page is ~65 KB.
A 500-page crawl (context-dev hard cap) or a 100k-URL sitemap would be **megabytes**.

### Response shapes (critical — they break distill differently)

- `scrapegraphai /api/scrape` → `data.results.markdown` — **content nested two levels deep**.
- `context-dev markdown` → `data.markdown` (top-level string), `data.html` for html.
- `serper` → `data.text` (top-level string) + `data.metadata` (object).
- `context-dev /web/crawl` → `data.results[]`, each `{markdown, metadata}` — **array of pages**.
- `brand-dev screenshot` → `data.screenshot` is a CDN URL string (cheap to keep).

## 2. Limitations hit

### L1 — `distill()` destroys scraped content (the big one)
`distill()` (distill.ts:10-37) caps the LLM-facing summary at 800 chars and, when over,
calls `topLevelScalars()` which only walks **top-level** scalar fields.

- **scrapegraphai / crawl:** the payload is `data.results.markdown` (or `results[]`).
  `topLevelScalars` finds no top-level string → for scrapegraphai it surfaces only
  `id: <uuid>`; for crawl it surfaces *nothing*. The model sees a UUID instead of 64 KB
  of page content. **Total content loss.**
- **context-dev / serper:** content *is* top-level (`markdown`/`text`), so distill surfaces
  it — but truncates at **800 of ~64,200 chars (98.8% lost)**, and silently mixes in
  sibling scalars (`success: true · url: ... · markdown: <first 800>`).

Either way the agent cannot read the page it just paid for, and `expand_result` only
works within the same turn (raw store is a per-turn in-memory Map, ports.ts:75).

### L2 — Raw store: unbounded, ephemeral, KV/context-bloat risk
The raw store is `mapKvPort()` — in-memory, **no size cap, not persisted** (ports.ts:75-78).
- A single HTML scrape (173 KB) or a multi-page crawl (MBs) sits in Worker memory
  (128 MB cap) with no eviction; a few large crawls in one turn risk OOM.
- If raw is ever moved to KV, **173 KB is fine but a 500-page crawl exceeds the 25 MB KV
  value limit**.
- Because it is per-turn, the full payload is gone next turn — re-fetching means paying again.

### L3 — Crawl latency vs the 30s timeout + no streaming + subrequest cap
`client.ts` uses a buffered fetch with a hard **30s timeout** and **no retry on paid `/run`**
(client.ts:40, :171). 
- example.com crawl returned in 4.1s for 1 page, but context-dev crawls up to 500 pages
  and olostep states crawls **"may take 1-10 mins."** Any real crawl **aborts at 30s**,
  the user is charged for work in flight, and there is no result.
- Synchronous crawl/sitemap also balloons one upstream call into many fetches on the
  provider side; if we ever fan out client-side we hit the Worker **subrequest cap
  (50 free / 1000 paid)**.
- Buffered reads mean a 173 KB (or larger) body is fully materialized in memory before distill.

### L4 — Dynamic pricing is unpriced pre-call
scrapegraphai, riveter, tavily are `hasDynamicPricing: true` and tell you to use **`dryRun`**.
The client never sends `dryRun`; `estimateCost` (client.ts:193-205) reads a static price
index and returns the catalog floor (e.g. $0.005 / $0.01). For a multi-format scrape,
`include_images`, `extract_depth: advanced`, or multi-URL `urls[]`, the real charge can be
several multiples — the budget gate under-estimates and the per-call warn can miss.

## 3. Recommendations

### R1 — Content-aware distill for scraping payloads (highest priority)
Make `distill()` recurse for known content fields instead of only top-level scalars:
- Walk a small allow-list of content keys at any depth — `markdown`, `text`, `html`,
  `content`, `raw_content`, and `results[].markdown` — and summarize **that** field, not
  the wrapper UUID.
- For long content, keep a **head + tail** slice (e.g. first 600 + last 200 chars) with a
  `…[N chars omitted, expand_result <id>]…` marker, instead of a blind 800-char head.
- Emit structured metadata in the summary (`url`, `title`, `chars`, `links`/`pages` counts)
  so the model knows what it has and can decide to expand. This single change fixes the
  scrapegraphai/crawl total-loss case and the context-dev truncation case.

### R2 — Size caps + durable, evictable raw store with pagination
- Add a `maxRawBytes` cap in the harness; if a `/run` `data` exceeds it (e.g. >256 KB),
  store a **truncated-with-pointer** form and flag `truncated: true` (distill already
  carries `rawBytes`/`truncated`).
- Move the raw store off the per-turn map to a durable, size-aware backend (DO SQLite or
  R2 for big blobs), keyed by `requestId`, with TTL/LRU eviction — so `expand_result` works
  **across turns** and a re-fetch isn't re-paid.
- For arrays (crawl `results[]`, sitemap URL lists), expose **paginated expansion**
  (`expand_result <id> --page N`) rather than returning the whole array; never inline a
  multi-MB crawl. Guard against the 25 MB KV ceiling if KV is used.

### R3 — Async/poll path for crawl; raise/scope the timeout for long ops
- Detect crawl/long-running endpoints (context-dev `/web/crawl`, scrapegraphai `/api/crawl`,
  tavily `/crawl`, **olostep `/v1/crawls` which is explicitly async**) and route them through
  a **submit → poll** flow: kick off the job, return a handle, poll the provider's
  status/pages GET endpoints (e.g. `/v1/crawls/{id}`, `/v1/crawls/{id}/pages`) on later
  turns. Prefer providers that already split submit/fetch.
- Give long ops a **per-endpoint timeout** above the default 30s (still bounded), and bias
  agents toward bounded params (`maxPages`, `maxDepth`, `chunks_per_source`) by default.
- Keep paid `/run` non-retried (correct — server doesn't dedupe idempotency-key), but on a
  crawl timeout surface the requestId so the user can poll rather than blindly re-paying.
- Streaming is **not available on Workers**; the realistic mitigation is the size cap (R2)
  plus the async/poll path, not response streaming.

### R4 — Honor `dryRun` for dynamic-pricing endpoints
When `details.hasDynamicPricing` is true, have `estimateCost`/the budget gate issue a
`dryRun` `/run` (free or near-free per provider) to get the exact cost **before** the real
call, instead of trusting the static floor price. Surface that figure in the per-call warn.

## Appendix — probe ledger (paid /run)

| call | cents |
|---|---|
| scrapegraphai scrape example.com | 0.5 |
| scrapegraphai scrape wikipedia | 0.5 |
| serper example.com (x2) | 4 |
| context-dev markdown example.com (x2) | 6 |
| brand-dev screenshot example.com | 3 |
| context-dev markdown wikipedia | 3 |
| context-dev html wikipedia | 3 |
| context-dev crawl example.com (1 page) | 3 |
| **total** | **~23 (parsed) + ~5 early = ~28¢** |

`/search` and `/details` are free. No full response bodies were printed or stored; only byte
counts and key shapes were captured. The API key was used only in `curl` headers and never
written to disk.
