# Harness Plan: People & Company Enrichment + Email Verification

Probe of the live Orthogonal gateway (`https://api.orthogonal.com/v1`) for the
enrichment / email-verification category, mapped against our Cloudflare harness
(`packages/harness/src/distill.ts`, `client.ts`, `apps/edge/src/ports.ts`).

Probe budget spent: **9.225¢** of the $0.40 cap (7 paid `/run` calls + 1 free).
All `/search` and `/details` are free. Inputs used were innocuous public values
(`stripe.com`, `support@stripe.com`).

## 1. Catalog

12 unique APIs surfaced across the 5 search queries: tomba, company-enrich,
contactout, peopledatalabs, nyne, ocean-io, crustdata, brand-dev, coresignal,
happenstance, didit, fiber.

Representative endpoints (price from free `/details`; raw bytes from paid `/run`,
measured on `data` payload with `wc`-equivalent byte count; depth = max JSON
nesting; "distill kept" = scalar fields the current 800-char distill would emit):

| api | endpoint | method | price | dynamic? | raw bytes | depth | distill kept / lost |
|-----|----------|--------|-------|----------|-----------|-------|---------------------|
| tomba | /v1/email-verifier | GET | $0.01 | no | ~3,800* | 4 | **0 useful** — all under `data.data.email` + 20-item `sources[]` |
| tomba | /v1/enrich | GET | $0.01 | no | 369 | 2 | 0 scalars; whole body fits <800 so passes intact (only by luck of size) |
| tomba | /v1/companies/find | GET | $0.01 | no | 2,550 | 4 | **0 useful** — everything under `data` / `meta`; truncated |
| tomba | /v1/email-finder | GET | $0.01 | no | (not run) | — | — |
| company-enrich | /companies/enrich | GET | $0.01225 | no | 5,528 | 4 | 15 scalars kept (name, employees, revenue, founded_year…); **drops** `location`, `financial`, `socials`, `technologies`, `industries`, `naics_codes` |
| company-enrich | /companies/workforce | GET | $0.06125 | no | (not run) | — | id/domain optional; headcount likely nested |
| company-enrich | /people/email | GET | $0.1225 | no | (not run — too pricey) | — | requires `id*` |
| company-enrich | /companies/autocomplete | GET | **free** | no | — | — | — |
| fiber | /v1/validate-email/single | POST | $0.02 | no | 269 | 2 | 0 scalars; under `output` / `chargeInfo` envelope; passes only because <800 |
| brand-dev | /v1/brand/retrieve-by-name | GET | $0.03 | no | 4,018 | 6 | **2 kept (`status`,`code`)** — the entire `brand` payload is nested and dropped |
| didit | /v3/email/check | POST | **free** | no | 250 | 1 | all 6 kept — flat, well-behaved (the exception) |
| peopledatalabs | /v5/person/enrich | GET | **$0.35** | no | (avoided) | — | many optional query params; deep profile |
| peopledatalabs | /v5/company/enrich | GET | $0.11 | no | (avoided) | — | — |
| contactout | /v1/email/enrich | GET | **$0.33** | no | (avoided) | — | requires `email*` |

`*` tomba/email-verifier byte count from the inspected raw body (depth-4
`data.data.email.{...}` + `whois` + 20-item `sources[]`); it was the most deeply
wrapped small-field response observed.

**No endpoint reported `hasDynamicPricing: true`** in this category — every
`/details` returned `dyn=false` with a fixed dollar price. Enrichment prices are
fixed but span **2 orders of magnitude**: 1¢ (tomba) → 35¢ (PDL person).

## 2. Limitations hit

### L1 — Scalar-only distill loses ~all enrichment value (the big one)
`distill()` (distill.ts:28) keeps only **top-level** scalar fields. Two failure
modes, both common in this category:

- **Envelope wrapping.** tomba (`data.data.email`), fiber (`output`), brand-dev
  (`brand`), tomba/companies-find (`data`+`meta`) all put the entire useful
  payload one level down under a wrapper key. Top-level scalars = **none**, so a
  truncated response distills to an **empty summary** (or just `status`/`code`).
  brand-dev (4 KB, depth 6) → LLM sees only `status: ok · code: 200`. tomba
  companies-find (2.5 KB) → LLM sees nothing.
- **Partial loss on flat-ish providers.** company-enrich/enrich keeps 15 useful
  scalars but silently drops `location`, `financial`, `socials`, `technologies`,
  `industries`, `naics_codes` — exactly the firmographic depth the call was paid
  for.

Small responses (tomba/enrich 369 B, fiber 269 B, didit 250 B) only survive
because they fall **under the 800-char cap** and pass through verbatim — i.e.
correctness today depends on payload size, not on distill doing the right thing.
The same providers at full fidelity (more matches, populated profiles) would
collapse to empty.

### L2 — No pre-flight required-param validation → wasted paid round-trips
`getDetails()` already returns `inputSchema` with `required` flags, but `run()`
(client.ts:155) never checks them. Omitting a required param surfaces as an
upstream **HTTP 422/400** *after* a network round-trip. Observed:
- tomba/email-verifier, no `email` → `422 {errors.type:"params_invalid"}`
- company-enrich/companies/enrich, no `domain` → `400`, empty `data`

These were **not billed** (validation is upstream of billing on the providers
tested, `priceCents:null`), but we still burn a subrequest, latency, and the user
gets a confusing low-level error instead of "you forgot `email`." On a provider
that validates *post*-billing this becomes a wasted charge.

### L3 — 422 is mis-mapped; structured upstream error is discarded
`httpError()` (client.ts:216) switches on 400/401/402/404/5xx. **422 is not
handled** → default branch → "unexpected 422" as `BAD_REQUEST`. Worse, the
gateway nests a structured provider error in the `data` field
(`{errors:{type:"params_invalid",message,code}}`) on a `success:false` body —
but that arrives via the **200-wrapped error path** (`success:false`,
`RunResponseSchema.parse`), not the HTTP-status path, so neither path reliably
turns it into a clean, actionable message.

### L4 — Paid `/run` not retried, but transient cold-start failures occur
First-touch calls to tomba returned `success:false` / `priceCents:null` once,
then succeeded verbatim on retry. `run()` deliberately passes `retries=0`
(correct — the server does **not** dedupe idempotency-key, so retry double-
charges). But that means a transient provider hiccup surfaces as a hard failure
to the user even though **no charge occurred**. We currently can't distinguish
"failed, not billed (safe to retry)" from "failed, maybe billed (unsafe)".

### L5 — Price variance + no per-call ceiling for this category
Prices range 1¢→35¢ with no dynamic-pricing signal to gate on. `perCallWarnCents`
exists in settings but there is no hard *block*; an agent that picks
`peopledatalabs/v5/person/enrich` over `tomba/v1/enrich` pays 35× more for a
similar answer. Large `sources[]`/match arrays also mean a single enrichment can
approach the 25 MB KV value limit if ever persisted (today the raw store is an
in-memory per-turn Map with no size cap — ports.ts mapKvPort — so a multi-call
turn can grow Worker memory toward the 128 MB ceiling unbounded).

## 3. Recommendations

### R1 — Nested-aware distill (walk one level deep + unwrap envelopes)
Replace scalar-only `topLevelScalars` with a depth-1 walk:
1. **Envelope unwrap:** if `data` has exactly one object/array child and few/no
   own scalars (e.g. `{data:{…}}`, `{output:{…}}`, `{brand:{…}}`), descend into
   it before summarizing. Covers tomba/fiber/brand-dev.
2. **One-level flatten:** emit `parent.child: value` for scalars found one level
   down (`location.country`, `financial.revenue`, `socials.linkedin`). Recovers
   company-enrich's dropped firmographics.
3. **Array summarization:** for arrays, emit `key: [N items]` + the first item's
   scalar keys (so `sources: [20 items: uri, website_url]`) instead of silently
   dropping them or blowing the char budget.
4. Keep storing the full raw by `requestId` for `expand_result`; consider raising
   the cap modestly (e.g. 1,200 chars) since enrichment answers are scalar-dense.

### R2 — Pre-flight required-param validation in `run()` (cheap, high value)
Before the paid POST, fetch/cache the endpoint's `inputSchema` (already produced
by `getDetails`) and assert every `required` query/body/path param is present and
non-empty. On miss, throw `BAD_REQUEST` ("missing required param `email` for
tomba /v1/email-verifier") **without** spending a subrequest or risking a charge.
This directly fixes L2 and turns L3's mangled 422 into a clean local error for the
common case.

### R3 — Handle 422 + surface the structured provider error
Add `case 422` to `httpError()` mapping to `BAD_REQUEST` (validation). In the
`success:false` 200-wrapped path, if `data.errors.message` / `data.error` exists,
lift it into the `OrthaError` message so the user sees
`params_invalid: required` instead of `API request failed with status 422`.
Secondary: classify these "not billed" failures distinctly from PROVIDER_DOWN.

### R4 (optional) — Per-call price gate + cheapest-first hinting
Wire a hard `perCallMaxCents` block (not just warn) so a 35¢ `person/enrich`
requires explicit budget headroom. When multiple APIs satisfy a query, prefer the
cheapest verified one (tomba 1¢ before PDL 35¢) — the search `score` is close
enough that price should break ties. Keeps category spend predictable given the
2-order-of-magnitude price spread and the absence of any dynamic-pricing signal to
reason about.
