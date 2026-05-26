# Harness Plan: Web Search, News & Answer Engines

Live probe of the Orthogonal API gateway (`https://api.orthogonal.com/v1`) for the
**Web Search, News & Answer Engines** category, mapped against our Cloudflare harness
limitations. All paid `/run` calls below were real charges (total ~6.3¢, well under the
$0.40 cap).

## 1. Catalog

Enumerated via FREE `/search` across: "search the web", "get recent news headlines",
"AI web search with citations", "search and summarize a topic", "find sources and
references". Prices/params from FREE `/details`. Raw bytes / #results from PAID `/run`
(✓ = measured live; — = not run, listed for completeness).

| api | endpoint | method | price ($) | dynamic? | raw bytes | #results | top-level shape |
|---|---|---|---|---|---|---|---|
| serper | `/search` | POST | 0.002 | no | 1,013 (num=2) → 3,422 (num=20→10) | 2 → 10 | `{searchParameters, organic[], relatedSearches[], credits}` ✓ |
| seltz | `/v1/search` | POST | 0.00625 | no | 27,078 (max_results=10) | 10 docs | `{documents[]}` — **no scalars** ✓ |
| andi | `/v1/search` | GET | 0.01 | no | 15,820 (limit=10) | multi (results+news+videos+images) | `{results_type, answer, type, title, results[], news[], videos[], images[], safeSearch, metrics}` ✓ |
| tavily | `/search` | POST | 0.01 | **yes** | 3,129 (3 res) → **412,467** (20 res + raw_content) | 3 → 19 | `{query, answer, results[], images[], follow_up_questions, response_time, request_id}` ✓ |
| tako | `/v1/knowledge_search` | POST | 0.023 | no | 3,949 | nested | `{outputs, request_id}` — outputs nested ✓ |
| context-dev | `/web/search` | POST | 0.03 | no | — | list | `query`-driven web search |
| context-dev | `/brand/ai/query` | POST | 0.03 | no | — | nested | answer-engine brand query |
| scrapegraphai | `/api/search` | POST | 0.075 | **yes** | — | list (numResults) | AI search + extraction |
| predictleads | `/v3/discover/news_events` | GET | 0.04 | no | — | list (limit/page) | paginated news feed |
| predictleads | `/v3/news_events/{id}` | GET | varies | no | — | single | news event by id |
| predictleads | `/v3/companies/{id}/news_events` | GET | varies | no | — | list | company news |
| tavily | `/research` | POST | varies | — | — | async (poll via `/research/{id}`) | deep research, async job |
| happenstance | `/v1/research` | POST | varies | — | — | async (poll `/v1/research/{id}`) | async research |

**Notes / out-of-scope-ish but co-located:** serper also exposes `/scholar`,
`/patents`, `/autocomplete`. olostep crawl endpoints (`/v1/crawls/...`, `/v1/retrieve`)
are FREE (`isPayable=false`) and async. predictleads/precip surfaced on the "news"
query but precip is weather (`/recent-rain`) — a relevance false-positive.

### Price range
$0.002 (serper) → $0.075 (scrapegraphai) per call. Most web-search tools cluster at
$0.002–$0.03. Two carry **dynamic pricing** (tavily, scrapegraphai) — the advertised
`price` is a floor, not a guarantee.

### Size range
~1 KB (serper, 2 results) → **412 KB** (tavily, 20 results + `include_raw_content`).
Typical "useful" calls (10–20 results, no full page text) land ~3–30 KB. Full-content
modes are the danger zone.

## 2. Limitations hit

### (A) Scalar-only distill DROPS the entire results array — the big one
`distill()` (packages/harness/src/distill.ts) truncates anything over 800 chars to
`topLevelScalars(data).join(" · ")`. For this whole category the *answer* lives in a
top-level **array** (`organic`, `results`, `documents`, `news`), which `topLevelScalars`
explicitly skips. Concretely, from live payloads:

- **serper** → only scalar is `credits`. Summary becomes `credits: 1`. **All 10 search
  results vanish.**
- **seltz** → top level is `{documents:[...]}`, **zero** scalars. `topLevelScalars`
  returns `[]`, so distill falls back to `json.slice(0,800)` — a truncated blob of the
  first document's JSON, mid-object. Useless and misleading.
- **andi** → `answer` + `title` scalars survive (partial luck), but the `results`,
  `news`, `videos` arrays — the citations — are dropped.
- **tako** → `{outputs, request_id}`; `outputs` is a nested object, dropped → summary is
  just `request_id: ...`.
- **tavily** → best case: `answer` (213 chars) + `query` survive, so the LLM at least
  sees the synthesized answer. But the `results[]` (the sources/citations) are dropped.

Note: if a provider ever returns a **bare top-level array** (not wrapped in an object),
`topLevelScalars` hits the `Array.isArray(data)` guard and returns `[]` immediately →
summary is a raw 800-char slice. Several of these tools are one upstream change away
from that.

### (B) Large multi-result payloads vs context + storage
tavily with `include_raw_content` returned **412 KB** for 20 results. The raw store is an
in-memory per-turn `Map` (apps/edge/src/ports.ts `mapKvPort`, no size cap), and the
fetch in client.ts is fully buffered (no streaming) under a 30s timeout. A few such calls
in one turn pile unbounded raw blobs into the 128 MB Worker heap. If raw is ever flushed
to KV, 412 KB is fine per value (25 MB cap) but unbounded accumulation across calls is
not. There is also no per-result truncation: one verbose page can dominate the payload.

### (C) Dynamic pricing not surfaced at the gate
tavily and scrapegraphai have `hasDynamicPricing=true`. `getDetails` in client.ts maps
`price → priceCents` and `estimateCost` multiplies that by `expectedCalls`, but the
`hasDynamicPricing` flag is **dropped** (not on `ToolDetails`). Cost estimates for these
two silently understate actual spend; the budget gate can't warn that the number is a
floor.

### (D) Async / job-style endpoints don't fit the one-shot run model
tavily `/research`, happenstance `/v1/research`, and olostep crawls are POST-then-poll
(`GET /research/{id}`). Our `run()` is single request/response with a 30s buffered
timeout and **no retry** on paid calls. A deep-research job that exceeds 30s will abort
and the poll-GET pattern isn't modeled at all.

### (E) GET-with-query endpoints
andi and predictleads are GET with all inputs in the query string. `run()` already
forwards `query`, and live andi worked via `{query:{q,limit}}` — fine, but worth noting
the category is mixed GET/POST so any handling must not assume a JSON body.

## 3. Handling recommendations

1. **List-aware distillation (highest priority).** Replace the scalar-only fallback with
   a shape detector that, when a top-level value (or the root) is an array, summarizes the
   array: emit `count`, then a **top-N preview** (e.g. first 3–5 items) where each item is
   reduced to its salient fields (`title`/`name`, `url`/`link`, a snippet trimmed to
   ~160 chars). Detect the results array by common keys (`results`, `organic`,
   `documents`, `news`, `items`, `data`, `outputs`) and fall back to "first array-valued
   field." Keep any top-level scalars (e.g. tavily `answer`, andi `answer`) AND the list
   preview — answer-engine answers are gold and currently only survive by luck.

2. **Structured "results preview" format + per-result truncation.** Standardize the
   distilled output as `{answer?, count, preview:[{title,url,snippet}], rawHandle}` instead
   of a flat string. Hard-cap snippet length per result and cap the preview to N items so a
   200-result or 412 KB raw payload still distills to a bounded, useful summary. The full
   body stays retrievable by `requestId` via `expand_result` within the turn.

3. **Cap & guard raw storage; treat full-content modes as opt-in.** Add a size cap to the
   raw store (e.g. refuse/spill > a few hundred KB) and, for known heavy params, default
   them off in tool descriptions (don't auto-set tavily `include_raw_content`). Consider a
   response-size ceiling in client.ts that records "truncated, N bytes dropped" rather than
   holding multi-hundred-KB blobs in the 128 MB heap. Be mindful of the subrequest cap
   (50 free / 1000 paid) when a turn fans out across many search tools.

4. **Surface `hasDynamicPricing` through to the budget gate.** Add the flag to
   `ToolDetails` and `CostEstimate.breakdown`, and when set, mark the estimate as a floor
   ("≥ X¢, dynamic") so the per-call warn / session cap logic can flag tavily &
   scrapegraphai instead of trusting a static number.

5. **Model async/job endpoints explicitly (or exclude for v1).** For tavily `/research`
   et al., either (a) keep them out of the auto-callable set for now, or (b) add a
   submit→poll helper with a longer budget than the 30s one-shot. Don't let a deep-research
   POST silently abort at 30s and surface as a generic timeout.

## Budget
Paid `/run` calls (6): serper×2 (0.4¢), tavily×2 (2.0¢), seltz×1 (0.625¢), andi×1 (1¢),
tako×1 (2.3¢) = **~6.3¢ of $0.40 cap**. Search and details calls were free.
