# Harness plan — Social Media, Contacts & Lead / Decision-Maker Discovery

Live probe of the Orthogonal gateway (`https://api.orthogonal.com/v1`) for the
social/contacts/lead-discovery category, mapped against our Cloudflare harness
(`packages/harness/src/{client,distill}.ts`, `packages/agent/src/loop.ts`).

- Probed via 5 FREE `/search` queries + ~16 FREE `/details` lookups.
- Measured response sizes with 8 PAID `/run` calls on cheap, read-only, public
  inputs (e.g. `stripe.com`). **Total paid spend: 23¢** (cap was 40¢).
- No mutating endpoint was ever called.

## 1. Catalog

12 unique APIs surfaced. `true side-effect?` = does the call mutate external
state (post/send/write), independent of HTTP method.

| API | endpoint | method | price | dynamic? | raw bytes | true side-effect? |
|---|---|---|---|---|---|---|
| tomba | `/v1/email-finder` | GET | $0.01 | no | **376** (measured) | read |
| tomba | `/v1/phone-finder` | GET | $0.01 | no | ~400 (est) | read |
| tomba | `/v1/combined/find` | GET | $0.01 | no | n/m | read |
| tomba | `/v1/author-finder` | GET | $0.01 | no | n/m | read |
| tomba | `/v1/phone-validator` | GET | $0.01 | no | n/m | read |
| scrapecreators | `/v1/twitter/profile` | GET | $0.02 | no | **3 139** (measured) | read |
| scrapecreators | `/v1/facebook/profile` | GET | $0.02 | no | n/m (fat, like twitter) | read |
| scrapecreators | `/v1/snapchat/profile` | GET | $0.02 | no | n/m | read |
| scrapecreators | `/v1/facebook/profile/posts` | GET | $0.02 | no | n/m (list) | read |
| aviato | `/company/founders` | GET | $0.02 | no | 400 on `website` param | read |
| aviato | `/company/employees` | GET | $0.02 | no | n/m (list) | read |
| predictleads | `/v3/discover/companies` | GET | $0.04 | no | 400 (param-strict) | read |
| contactout | `/v1/domain/enrich` | **POST** | $0.03 | **yes** | **1 915** (measured) | **read** (POST-as-query) |
| contactout | `/v1/people/count` | POST | $0 (free) | no | n/m | read |
| contactout | `/v1/people/enrich` | POST | $0.55 | no | n/m (not run; pricey) | read |
| contactout | `/v1/email/enrich` | GET | $0.55 | yes | n/m | read |
| contactout | `/v1/linkedin/enrich` | GET | $0.55 | **yes** | n/m (not run; pricey) | read |
| contactout | `/v1/people/linkedin` | GET | $0.55 | yes | n/m | read |
| company-enrich | `/people/email` | GET | $0.1225 | no | n/m | read |
| peopledatalabs | `/v5/company/search` | **POST** | $0.11 | **yes** | **3 970** (measured) | **read** (POST-as-query) |
| crustdata | `/screener/companydb/search` | POST | n/m | n/m | n/m (list) | read (search) |
| crustdata | `/screener/identify/` | POST | n/m | n/m | n/m | read |
| sixtyfour | `/find-phone` | **POST** | $0.30 | no | n/m (not run; pricey) | **read** (POST-as-query) |
| fiber | `/v1/validate-phone/single` | **POST** | $0.06 | no | **562** (measured) | **read** (validation) |
| edges | `/actions/linkedin-find-profile-url/run/live` | **POST** | $0.06 | no | 400 (input fmt) | **read** (AI lookup) |
| edges | `/actions/linkedin-find-company-url/run/live` | POST | $0.06 | no | n/m | read |
| edges | `/actions/linkedin-search-people/run/live` | POST | n/m | no | n/m (list) | read |
| edges | `/actions/linkedin-search-company-employees/run/live` | POST | n/m | no | n/m (list) | read |
| edges | `/actions/linkedin-search-jobs/run/live` | POST | n/m | no | n/m (list) | read |
| nyne | `/person/single-social-lookup` (POST) | POST | n/m | n/m | n/m (async initiator) | read (starts job) |
| nyne | `/person/social-profiles` (POST) | POST | n/m | n/m | n/m (async initiator) | read (starts job) |
| nyne | `/person/interactions` (POST) | POST | n/m | n/m | n/m (async initiator) | read (starts job) |
| nyne | `/person/social-profiles` (GET) | GET | **$0** | no | n/m (poll) | read (poll) |
| nyne | `/person/single-social-lookup` (GET) | GET | $0 | no | n/m (poll) | read (poll) |
| nyne | `/person/interactions` (GET) | GET | $0 | no | n/m (poll) | read (poll) |

`n/m` = not measured (avoided to stay under budget, or pricey/list-shaped).

**Measured size range: 376 B → ~4.0 KB.** Single-entity lookups (tomba, fiber)
are small (~300–600 B); social-profile scrapes and company-search lists are fat
(3–4 KB) and will grow with `limit`/`perPage` on the search/list endpoints
(edges/crustdata/pdl/aviato/scrapecreators-posts), which can reach tens of KB.

### Observations from probing
- **Every endpoint in this category is read-only.** None post, send, or message.
  Yet **8+ are POST** (contactout, pdl, sixtyfour, fiber, edges, crustdata, nyne
  initiators) — all POST-as-query / POST-as-search, never mutating.
- **Failed calls (4xx) are NOT charged** (`priceCents` absent on every error we
  hit: aviato, predictleads, edges). Good — but the harness still treats them
  uniformly.
- **Param typing is strict.** `predictleads` 400s on `limit` whether sent as
  number or string; pdl needs `sql` xor `query`. The LLM will frequently mis-fill
  params and burn round-trips (though not money).
- **`nyne` is async** — POST initiates a job, GET polls with `request_id`
  (price $0). Same path string serves both methods.
- **Bodies echo their own price** (`fiber.chargeInfo`, `contactout.status_code`,
  pdl `total`/`dataset_version`) — redundant noise that inflates raw bytes.

## 2. Limitations hit

### L1 — `sideEffect` classification is method-only AND unwired (highest impact)
`client.ts:151` derives `sideEffect = method === "GET" ? "read" : "write"`. Two
compounding problems:

1. **Mislabels the whole category.** Every contactout/pdl/sixtyfour/fiber/edges/
   crustdata/nyne POST is a pure read (lookup/search/validate), but all are
   tagged `"write"`. If the side-effect gate were active, the user would be
   prompted for permission on *every* phone/email/company lookup — alarm fatigue
   that trains users to blind-approve.
2. **The gate is dead code.** `trace.ts:46` defines `kind: "side_effect"`, but
   `loop.ts` only ever emits `kind: "cost"` (lines 248–264). Nothing reads
   `details.sideEffect`. So today the cautious label has zero effect — and the
   day someone *wires* a `sideEffect === "write"` gate, this category floods with
   false prompts. The classification must be fixed **before** the gate is wired.

There is currently **no real protection against a genuine mutation** (a future
"post to LinkedIn" / "send email" endpoint) either: method-only would correctly
flag it `write`, but nothing acts on that flag.

### L2 — List/profile payloads collapse to scalars in `distill()`
`distill.ts` keeps only **top-level scalar** fields when output > 800 chars
(`topLevelScalars`, lines 28–37). For this category that is actively harmful:
- `pdl /v5/company/search` → `{status, data:[...], scroll_token, total, ...}`:
  distill emits `status · total · scroll_token · dataset_version` and **drops the
  entire `data` company array** — i.e. the answer.
- `contactout /v1/domain/enrich` → `{status_code, companies:[...]}`: emits only
  `status_code`, drops `companies`.
- `scrapecreators` profiles (3 KB) have useful scalars at top level (handle,
  followers) but also nested `core`/`avatar` objects that vanish — partial loss.

Any "find decision makers / employees / search companies" result (the lead-gen
core of this category) is a list nested one level down, so the most valuable
calls are exactly the ones distill guts.

### L3 — No async / polling model (nyne), and method/path collision
`nyne` requires POST-to-start → GET-to-poll(`request_id`). The harness has no
notion of: (a) a paid initiator that returns a token, (b) polling a $0 GET until
ready, (c) carrying `request_id` across steps. Worse, `nyne`'s POST and GET share
the same path (`/person/social-profiles`), and `/details` returns only the GET
variant — so `getDetails` silently resolves the wrong method/price for the
initiator. Same-path/two-method endpoints break the `slug+path` price index key
(`client.ts:46`, `priceKey`).

### L4 (secondary) — Dynamic pricing not surfaced
contactout (`domain/enrich`, all `/enrich`) and pdl (`company/search`) report
`hasDynamicPricing: true`. `ToolDetails` carries a single `priceCents` and
`estimateCost` (`client.ts:193`) multiplies it as if fixed; the `hasDynamicPricing`
flag is dropped on the floor. Budget pre-flight (`loop.ts:235`) can under-estimate,
so a call the gate "approved" at $0.03 may settle higher. (Settlement uses the
real `priceCents` from `/run`, so we don't lose money — but the gate's estimate
and any shown cost can be wrong.)

### L5 (secondary) — Fat bodies waste the 128 MB worker / KV budget
3–4 KB per call today, and list endpoints scale with `limit`. The raw store
(`mapKvPort`) is in-memory, per-turn, **uncapped**. A lead-gen turn that pages
through company search (10–50 results × several calls) could hold hundreds of KB
of raw JSON in worker memory and, if checkpointed, approach the 25 MB KV value
limit. Provider bodies also carry redundant price-echo noise (`chargeInfo`, etc.).

## 3. Handling recommendations

### R1 — Replace method-only side-effect classification (do before wiring the gate)
- Default POST in this category to **`read`**, not `write`. Method alone is wrong
  for x402 lookup APIs where POST = "query with a JSON body".
- Derive `sideEffect` from a **verb/path/description heuristic**, not just method:
  treat as `write` only when path or description contains `send|post|create|
  message|dm|publish|update|delete|email/send`; otherwise `read`. Tag genuine
  unknowns `"unknown"` (the enum already supports it; `client.live.test.ts:33`).
- Allow a per-provider/per-endpoint override map for the rare true mutation, so
  classification isn't purely inferred.
- **Then** wire the gate: in `loop.ts`, when `details.sideEffect === "write"`,
  emit `permission_required` with `kind: "side_effect"` (already in `trace.ts`),
  independent of cost. This is the only path that protects against a real
  posting/sending endpoint — today there is none.

### R2 — Structure-aware distillation for lists
- In `distill()`, when a top-level value is an **array** (or the known wrapper
  keys `data`/`companies`/`results`/`profiles`/`employees`), summarize the array:
  emit `count` + the first N (e.g. 3) items reduced to their own scalars, instead
  of discarding it. Keep the full array in the raw store by `requestId` for
  `expand_result`.
- Recurse one level for single-object wrappers (`{status, data:{...}}`) so the
  payload — not just envelope scalars — survives.
- Raise/relax the 800-char cap for list endpoints, or make it byte-budget-aware
  per call, since a useful lead list legitimately needs more than 800 chars.

### R3 — Model async lookups + fix path/method collisions
- Teach the harness an **async-job pattern**: a POST initiator returns a
  `request_id`; expose a follow-up "poll" step bound to the $0 GET, and let the
  loop carry `request_id` between same-turn steps. Cap poll attempts.
- Key the price index and `getDetails` by **`slug + method + path`**, not
  `slug + path` (`client.ts:46`), so nyne's POST initiator and GET poller don't
  alias. Have `getDetails` accept/return method to disambiguate same-path pairs.
- Surface `hasDynamicPricing` on `ToolDetails`; when true, mark the
  `estimateCost` breakdown `hasUnknownPrices`/approximate so the cost gate and UI
  show "~$X (variable)" and don't present a falsely precise number.

### R4 — Treat failed calls + size hygiene explicitly
- 4xx errors are not charged: it's safe to **auto-retry once on a 400 with
  corrected/looser params** (param-typing is the top failure here, e.g.
  predictleads). Keep the existing no-retry rule only for paid 5xx/timeout
  (`client.ts:171`) where a charge may have landed.
- Strip provider price-echo noise (`chargeInfo`, `credits_remaining`,
  `dataset_version`) before distilling/storing.
- Add a soft size cap + count to the per-turn raw store so a paging lead-gen turn
  can't grow worker memory unbounded toward the KV 25 MB limit.

## Appendix — measured PAID calls (8 total, 23¢)

| call | priceCents | raw bytes | result |
|---|---|---|---|
| tomba `/v1/email-finder` (stripe.com / P. Collison) | 1 | 376 | ok, compact profile |
| scrapecreators `/v1/twitter/profile` (@stripe) | 2 | 3 139 | ok, fat profile |
| contactout `/v1/domain/enrich` (stripe.com) | 3 | 1 915 | ok, `{status_code, companies[]}` |
| fiber `/v1/validate-phone/single` | 6 | 562 | ok, `{output, chargeInfo}` |
| peopledatalabs `/v5/company/search` (sql, size 1) | 11 | 3 970 | ok, `{status, data[], total, ...}` |
| aviato `/company/founders` (website param) | 0 | 321 | 400, not charged |
| predictleads `/v3/discover/companies` | 0 | 191 | 400 (param-strict), not charged |
| edges `linkedin-find-profile-url` | 0 | 238 | 400 (input fmt), not charged |
