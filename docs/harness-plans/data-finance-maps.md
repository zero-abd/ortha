# Harness Plan: Finance/Market Data, Maps/Places, Weather & Misc Utility

Live probe of the Orthogonal API gateway (`https://api.orthogonal.com/v1`) for the
**Finance/Market Data, Maps/Places, Weather & Misc Utility** category, mapped against our
Cloudflare harness limitations. All paid `/run` calls below were real charges (total
~8.0¢, well under the $0.40 cap). This is a catch-all data category; the unifying harness
risk is that almost every useful payload is a **time-series or list** nested behind a few
top-level keys.

## 1. Catalog

Enumerated via FREE `/search` across: "get stock price", "cryptocurrency price", "geocode
an address / places near a location", "weather forecast", "currency exchange rate",
"company financials", plus "historical price time series / OHLC", "maps directions
routing", "market data quote", "misc utility". Prices/params from FREE `/details`. Raw
bytes / #items from PAID `/run` (✓ = measured live; — = not run, listed for completeness).

| api | endpoint | method | price ($) | dynamic? | raw bytes | #items | top-level shape |
|---|---|---|---|---|---|---|---|
| serper | `/places` | POST | 0.002 | no | 2,659 (num=3) ≈ 2,644 (num=20) | **10 (capped)** | `{searchParameters, places[], credits}` ✓ |
| dome | `/crypto-prices/binance` | GET | 0.01 | no | **94** (latest) → **7,054** (7d, limit=100) | 1 → **100** | `{prices[], total, pagination_key?}` ✓ |
| dome | `/polymarket/candlesticks/{condition_id}` | GET | 0.01 | no | — | OHLC series | candlestick array, requires `condition_id` + start/end ✓desc |
| dome | `/crypto-prices/chainlink` | GET | 0.01 | no | — | series | same shape as binance |
| dome | `/kalshi/market-price/{market_ticker}` | GET | 0.01 | no | — | single/series | market price |
| precip | `/api/v1/daily` | GET | 0.01 | **yes** | 2,658 (14 days) | 14 (in `features[0]`) | GeoJSON `{type, features[]}`, series nested in `features[0].properties` ✓ |
| precip | `/api/v1/hourly` | GET | 0.01 | **yes** | **24,394** (168h window) | **145** (in `features[0].properties.hours[]`) | GeoJSON, deeply nested hourly array ✓ |
| precip | `/api/v1/temperature-hourly` | GET | 0.01 | **yes** | — | hourly series | same nested GeoJSON shape |
| precip | `/embed/location` | GET | 0.10 | no | — | **HTML page** | returns a full HTML document, not JSON |
| aviato | `/geocoder/search` | GET | 0.01 | no | **4,101** | **8 (root array)** | **bare top-level array** of geocode matches ✓ |
| aviato | `/company/funds` · `/company/investments` | GET | 0.01 | no | — | list | fund/investment lists |
| brand-dev | `/v1/brand/retrieve-by-ticker` | GET | 0.03 | no | — | nested | brand object keyed by stock ticker |
| context-dev | `/brand/retrieve-by-ticker` | GET | varies | no | — | nested | ticker→brand lookup |
| fundable | `/company/search` | GET | 0.011 | no | — | id/list | fuzzy company id lookup |
| fundable | `/company` | GET | 0.066 | no | — | object | company + latest funding round |
| fundable | `/company/deals` · `/deals/{id}` · `/investor/deals` | GET | 0.066+ | no | — | list/object | deal & investor records |
| serper (maps) | `/places` | POST | 0.002 | no | (see above) | 10 | also the de-facto "places near location" tool |
| tavily | `/map` | POST | varies | **yes** | — | nested | site map crawl (not geo maps) |
| olostep | `/v1/maps` | POST | varies | — | — | list | site URL map (not geo maps) |
| fiber | `/v1/google-maps-search/start` `/check` | POST | varies | — | — | async | POST-then-poll google maps scrape |

**Notes / relevance false-positives.** There is **no native currency-FX or
stock-quote-by-OHLC** provider in the catalog — "currency exchange rate" and "market data
quote" both resolved to crypto (dome) or company-funding (fundable) tools, not classic FX
or equities quotes. "maps/directions/routing" returns *site-map crawlers* (tavily/olostep
`/map`, fiber google-maps-search), **not** geographic routing/distance APIs. "Misc
utility" surfaced verification/scrape tools (didit phone, riveter, crustdata) that belong
to other categories. Genuine fits for this category: serper places, dome crypto, precip
weather, aviato geocoder, brand-dev ticker, fundable financials.

### Price range
$0.002 (serper places) → $0.10 (precip `/embed/location`) per call. The data workhorses
cluster at **$0.01** (dome, precip, aviato). Company financials are pricier (fundable
`/company` $0.066). **Precip's three measured endpoints all carry dynamic pricing** — the
advertised $0.01 is a floor only (see §2C).

### Size range
**94 bytes** (dome latest crypto price, 1 item) → **24 KB** (precip hourly, 145-point
series). The decisive variable is **#array items**, not the endpoint: the *same* dome
endpoint went 94 B → 7 KB (75×) just by adding a time range. Single-fact lookups (latest
price, one geocode) are tiny and distill fine; series/list calls (forecasts, candlesticks,
places, geocoder candidates) are where the harness loses data.

## 2. Limitations hit

### (A) Scalar-only distill DROPS the time-series / list — the big one
`distill()` (packages/harness/src/distill.ts) truncates anything over 800 chars to
`topLevelScalars(data).join(" · ")`. In this category the *answer is the array*, and the
array is exactly what `topLevelScalars` skips. Worse than the search category, the arrays
here are often **deeply nested**, so even the partial-luck scalar survival doesn't happen:

- **dome `/crypto-prices/binance`** → top level is `{prices:[...100 points...], total}`.
  Only scalar is `total`. A 100-point BTC price history (7 KB) distills to `total: 100`.
  **The entire series vanishes**, including the actual price.
- **precip `/api/v1/daily` & `/hourly`** → GeoJSON `{type, features[]}`. The forecast is at
  `features[0].properties.hours[]` (hourly) / daily entries — **two levels deep**. Top-level
  scalars are just `type: "FeatureCollection"`. A 145-point hourly forecast (24 KB) distills
  to `type: FeatureCollection`. Catastrophic and misleading.
- **aviato `/geocoder/search`** → response is a **bare top-level JSON array** of 8 matches.
  `topLevelScalars` hits the `Array.isArray(data)` guard and returns `[]` immediately, so
  distill falls back to `json.slice(0,800)` — a truncated blob mid-second-object. All 8
  candidate locations effectively lost; the "best match" the caller wanted is unidentified.
- **serper `/places`** → `{searchParameters, places[], credits}`. Only scalar is `credits`.
  Summary becomes `credits: 1`; **all 10 businesses (names, addresses, ratings, coords)
  vanish.**
- **fundable `/company`** → company object with a nested latest-funding-round; the funding
  figures are nested and dropped.

Even where a "small" call is involved (dome latest = 94 B, under the 800-char cap so the
raw 1-item array passes through verbatim), the moment a time range is added the same
endpoint blows past the cap and collapses. Distill behavior is thus **input-dependent and
silently lossy** for a single endpoint.

### (B) Large nested series vs context + storage
precip hourly returned **24 KB** for one week; a month of hourly across multiple weather
variables (temperature, wind, cloud, precip — each its own endpoint) fans out into several
20–30 KB blobs in a single turn. The raw store is an in-memory per-turn `Map`
(apps/edge/src/ports.ts `mapKvPort`, no size cap) and the fetch in client.ts is fully
buffered (no streaming) under a 30s timeout. Multiple series calls pile unbounded raw
GeoJSON into the 128 MB Worker heap. There is no per-item truncation: a long forecast or a
100-row deal list dominates the payload with no preview/cap.

### (C) Dynamic pricing not surfaced at the gate
All three measured **precip** endpoints have `hasDynamicPricing=true`, and the live charges
proved the advertised $0.01 is only a floor: daily billed **2.6¢** (2.6× the advertised
1¢) while hourly billed **1.2¢** — and, counter-intuitively, the 24 KB hourly call was
*cheaper* than the 2.7 KB daily call. So actual cost tracks neither bytes nor the static
price. `getDetails` in client.ts maps `price → priceCents` and `estimateCost` multiplies by
`expectedCalls`, but the `hasDynamicPricing` flag is **dropped** (not on `ToolDetails`).
Estimates for precip silently understate spend and can't be flagged as a floor.

### (D) Strict gateway query-param typing on GET endpoints (new finding)
dome and precip are GET-with-query. The gateway **validates query-param types against the
OpenAPI schema and rejects mismatches before the upstream call**: sending numeric
`start_time`/`limit` as JSON numbers failed with `{"error":"Expected string, received
number"}` (HTTP-level), and the call had to be re-sent with those values **as strings**
(`"start_time":"177..."`). Our `run()` forwards `query` as-is; if a caller (or the LLM)
emits a JSON number for a param the schema declares `string`, the **paid** call is
rejected. Combined with "paid /run not retried" (client.ts), this is a wasted round-trip
and a confusing failure. (Note: in this case the gateway rejected pre-charge, so no spend —
but the request still failed.)

### (E) Non-JSON / async / page-style responses
- precip `/embed/location` ($0.10) returns a **full HTML document**, not JSON. `distill()`
  assumes JSON (`topLevelScalars` / `JSON` slice); an HTML string would either be sliced to
  800 chars of markup or mishandled.
- fiber `/v1/google-maps-search/start` + `/check` is **POST-then-poll**, and tavily/olostep
  `/map` are crawl jobs. Our one-shot `run()` (30s buffered, no retry) doesn't model
  submit→poll.
- dome series expose a `pagination_key` (max 100 items/page). Multi-page history requires
  follow-up calls our run model doesn't chain.

### (F) No rate limiting observed
4 rapid-fire serper `/places` calls all returned HTTP 200 — **no 429** and no throttling
seen at this volume. So back-off logic isn't urgent, but the **subrequest cap** (50 free /
1000 paid per request) remains the real fan-out ceiling when a weather query hits several
per-variable hourly endpoints in one turn.

## 3. Handling recommendations

1. **Series/list-aware distillation with deep-path detection (highest priority).** Replace
   the scalar-only fallback with a shape detector that finds the payload's primary array
   **even when nested**. Probe common keys at the root AND one or two levels down:
   `prices`, `places`, `results`, `data`, `items`, `features` (then into
   `features[].properties.{hours,days,...}`), and the **bare-root-array** case
   (`Array.isArray(data)` → that *is* the list, e.g. aviato geocoder). Emit `count` + a
   **top-N preview** (3–5 items) with salient fields only. Keep surviving top-level scalars
   (e.g. `total`) alongside the preview.

2. **Domain-aware item reducers + units/field selection.** A generic preview isn't enough
   for numeric series. For time-series (dome prices, precip hours), summarize as
   `{count, first:{t,v}, last:{t,v}, min, max, mean}` plus a sparse sample — the caller
   usually wants the trend/latest, not 100 raw rows. For places/geocoder lists, reduce each
   item to `{name/title, address, lat, lon, rating}` and **drop verbose fields**. Carry the
   `units`/`timeZoneId` precip ships in `properties` so values stay interpretable. Cap the
   preview to N items so a 145-point forecast or long deal list distills to a bounded,
   useful summary; full body stays retrievable by `requestId` via `expand_result`.

3. **Surface `hasDynamicPricing` through to the budget gate, and treat bytes ≠ cost.** Add
   the flag to `ToolDetails` and `CostEstimate.breakdown`; when set (precip), render the
   estimate as a floor ("≥1¢, dynamic") so per-call warn / session-cap logic flags it.
   Don't infer cost from response size — the live data shows they're uncorrelated
   (cheaper-but-bigger hourly vs pricier-but-smaller daily).

4. **Coerce query params to the declared schema type before a paid call.** Since the
   gateway strictly type-checks query params (§2D) and paid `/run` isn't retried, have
   `run()`/`getDetails` use the `queryParams[].type` from `/details` to **stringify numeric
   params the schema declares `string`** (and vice-versa) before sending. At minimum, when a
   paid call fails with a `Expected string, received number`-style validation error, retry
   **once** with coerced types rather than surfacing a wasted failure. Validate required
   params (e.g. dome candlesticks needs `condition_id`+start+end) up front.

5. **Cap raw storage; detect non-JSON; model async/paginated explicitly (or exclude v1).**
   Add a size cap to the raw store and a per-turn fan-out budget mindful of the subrequest
   cap, so several 20–30 KB weather series don't accumulate unbounded in the 128 MB heap.
   Detect non-JSON responses (precip `/embed/location` HTML) and store/label them as text
   instead of running JSON distill. For POST-then-poll (fiber google-maps-search, tavily
   `/map`) and `pagination_key` continuation (dome), either keep them out of the
   auto-callable set for v1 or add a submit→poll / next-page helper with a budget beyond the
   30s one-shot.

## Budget
Paid `/run` calls (8 successful charges): serper `/places` ×6 (0.2¢ ×6 = 1.2¢ — incl. a
4-call rate-limit probe), dome crypto latest 1¢, dome crypto 7d-series 1¢, precip daily
2.6¢, precip hourly 1.2¢, aviato geocoder 1¢ = **~8.0¢ of $0.40 cap**. (Two further paid
attempts — dome bad currency format, dome numeric timestamps — were rejected by the gateway
pre-charge, $0.) Search and details calls were free.
