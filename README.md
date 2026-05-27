# Ortha

## ▶ Live app — https://ortha-web.pages.dev

API (Cloudflare Worker): https://ortha-edge.almahmud-zero.workers.dev

A web-based AI chat app where the assistant has real, runtime access to **Orthogonal's API catalog** — company data, contacts, lead/people search, enrichment, social, funding, news — plus general web search and scraping. You have a normal conversation; Ortha discovers the right API at runtime, calls it, and answers with real data.

> Bring-your-own-key: add a model key (Gemini/Anthropic/OpenAI/OpenRouter) and an Orthogonal key in **Settings**. Keys are encrypted and stored **per device** (never synced); chats and settings sync across your devices.

---

## How it handles the hard parts

The five system-design challenges this project calls out — each is a deliberate part of the design, detailed further down:

| Challenge | How Ortha handles it |
|---|---|
| **The context window fills up** — big API responses *and* long history | Tool results are **distilled** into context while the full payload is stored **out-of-context** and pulled back only on demand (`expand_result`); history is windowed and older turns fold into a **rolling summary**. → [Context-window management](#context-window-management) |
| **Conversations must persist** — leave and come back | Each conversation is a **Durable Object with its own SQLite**; reopening rehydrates the transcript *and* reconstructs the agent-trace blocks (with price/latency/Open-raw), synced across devices by account. → [Persistence](#persistence) |
| **System design** — databases, architecture, scale | Stateless Worker router → **one Durable Object per conversation** (SQLite) + **KV** (sessions/settings/keys) + **D1** (accounts/spend); scales **horizontally by conversation**. → [System design](#system-design) |
| **Many users hitting the same APIs** | Every conversation is an **isolated DO** (no cross-user contention); spend is enforced **atomically per workspace**; within a turn, identical calls are **coalesced** and a failing endpoint trips a **per-provider circuit breaker**. → [Concurrency](#concurrency-many-users-hitting-the-same-apis) |
| **An API is slow or down** | The chat **never hangs or dead-ends**: a call times out at 30s, a failure surfaces in the trace and is fed back so the agent **adapts** — another endpoint, or an answer from what it already has. → [When an API is slow or down](#when-an-api-is-slow-or-down) |

---

## What it does

- **Self-extending agent.** Instead of hard-wiring integrations, the model is given four meta-tools and discovers everything at runtime: `search_tools` (find an endpoint in Orthogonal's catalog), `get_tool_details` (inspect its schema/price/side-effects), `run_tool` (execute it through a budgeted harness), `expand_result` (pull a full payload on demand). It also has always-on, free `web_search` / `web_scrape`.
- **Context-frugal tool calls — the core trick.** A single API response can be hundreds of KB, far too big to drop into the model's context. So `run_tool` **distills each result to a compact summary that goes into context, while the full raw payload is stored out-of-context** in the conversation's Durable Object, keyed by a `requestId`. The model reasons from the summary; only if that's insufficient does it call `expand_result(requestId)` to pull the full payload back in. The same applies to web scrapes. Together with history windowing and a rolling summary (see [Context-window management](#context-window-management)), this keeps the window small whether one response is huge or the conversation runs for hours — and it's why the trace's "Open raw" can still fetch the complete payload long after the turn.
- **Real results.** "Enrich stripe.com with funding and team size," "Find VPs of Sales at Stripe," "What raised a Series A in fintech this month?" — the agent routes to the right catalog endpoint (Apollo, Fiber, Fundable, PredictLeads, Crustdata, ScrapeCreators, …) and returns grounded data, with web search for current/open-web questions.
- **Provider-agnostic models.** Gemini 3 Flash (default) and Gemini 3 Pro, plus Anthropic, OpenAI, and OpenRouter adapters — switch provider/model in Settings.
- **Skills.** Save reusable prompt workflows, or browse **Public skills** pulled live from `orthogonal.com/skills` (one click to "Add to my skills," then run via `/<skill>`). A skill runs **inline** in the same agent loop — its `SKILL.md` drives the catalog/web tools, and its tool results distill exactly like any other turn's.
- **Parallel agent runs.** Every turn is tracked as an independent "run" in an **Agents panel**; **Batch** fans the same prompt across many inputs (e.g. enrich 50 domains), each its own agent run streaming the same trace and distilling its own results — so a bulk job neither bloats nor blocks your main chat.
- **Transparent + safe.** Every tool call streams to a live trace. Expensive calls and any **write/side-effect** (e.g. sending an email) pause for explicit approval. Per-conversation and monthly **spend caps** are enforced at the database.
- **Rich rendering.** Answers render as full GitHub-flavored markdown — tables, fenced/highlighted code, LaTeX — streamed token-by-token.
- **Accounts.** Email+password and Google sign-in; conversations + settings persist and sync.

---

## Architecture

Everything runs on Cloudflare's edge. The Worker is a stateless router; all per-conversation state lives in a **Durable Object** (one instance per conversation, with embedded SQLite).

```
                         ┌──────────────────────────────────────────────┐
  Browser (React/Vite)   │              Cloudflare Edge                  │
  ortha-web.pages.dev    │                                              │
        │                │   ┌────────────────┐                         │
        │  REST /api/*   │   │  Worker (router)│  auth, settings, keys,  │
        ├───────────────▶│   │   ortha-edge   │  usage, skills proxy    │
        │                │   └────────┬───────┘                         │
        │  WS /stream    │            │ per-conversation                │
        └───────────────▶│   ┌────────▼─────────────────────────────┐   │
            (turn events)│   │  ConversationDO  (1 per conversation) │   │
                         │   │  ── embedded SQLite ──                │   │
                         │   │  messages · tool_calls · call_journal │   │
                         │   │  summaries · raw_blobs                │   │
                         │   │                                       │   │
                         │   │  runs the Agent loop ───────────────┐ │   │
                         │   └──────────────────────────────────┐  │ │   │
                         │        │ LLM (BYOK)   │ Orthogonal     │  │ │   │
                         │        ▼              ▼ harness        │  ▼ │   │
                         │   Gemini/Claude/   api.orthogonal.com  │ web   │
                         │   OpenAI/OpenRouter (catalog + run)    │ search/
                         │                                        │ scrape│
                         │   KV: sessions · conv-index · settings · device keys · skills cache
                         │   D1: users · workspaces · spend (atomic budget)
                         └──────────────────────────────────────────────┘
```

**The agent loop** (`packages/agent`) is an async generator that yields trace events (`token`, `tool_call_started`, `tool_result`, `permission_required`, `cost_update`, `done`) streamed over the WebSocket. Each turn: the model either answers or requests a tool; the harness executes it (budget-checked, idempotent), distills the result back into context, and the loop continues until a complete answer.

**Monorepo** (Bun workspaces, TypeScript):

| Package | Responsibility |
|---|---|
| `contracts` | Frozen interfaces (the seams) every module builds against, plus in-memory mocks. |
| `agent` | The self-extending loop + tool/prompt definitions. |
| `harness` | Orthogonal API client (timeout, retry, circuit breaker), web client (search/scrape), result distillation. |
| `llm` | Provider adapters (Anthropic-native + one OpenAI-compatible adapter for Gemini/OpenAI/OpenRouter) + the model catalog. |
| `context` | Prompt-window assembly under a token budget, rolling conversation summary, retrieval, token estimation. |
| `budget` | Reservation policy (reserve → run → settle/refund). |
| `auth` | PBKDF2 password hashing, session tokens, Google OAuth exchange. |
| `db` | D1/SQLite stores: the conversation transcript (messages + tool metadata) and the atomic-spend logic (`tryReserveSpend`). |
| `apps/edge` | The Worker, the `ConversationDO`, and all routes. |
| `apps/web` | The React UI. |

---

## System design

### Databases — what and why

| Store | Used for | Why |
|---|---|---|
| **Durable Object + SQLite** (one per conversation) | Full transcript: messages, tool calls (with requestIds), the idempotency journal, rolling summaries, and **raw tool payloads** kept out of context. | A conversation is a natural single-writer unit. Co-locating its state with the compute that runs the turn removes cross-request contention and gives strongly-consistent, serialized reads/writes for free — no distributed locking. |
| **KV** | Sessions (`session:<token>`), per-workspace conversation index, workspace settings, **device-scoped BYOK keys**, public-skills cache. | Cheap, globally-replicated, read-heavy lookups (one fast read per request). Eventual consistency is fine for these (keys are read with strongly-consistent `get`, not `list`). |
| **D1** (SQLite) | Accounts: users, workspaces, memberships; and **spend** (monthly reserved/settled vs. cap). | Needs cross-conversation aggregation and a transactional integrity guarantee (no overspend) that a single-writer relational store gives cleanly. |

### How it scales

- **Horizontal by conversation.** Each conversation is its own Durable Object, so load spreads across thousands of independent DOs at the edge; there is no shared hot path between unrelated conversations. The Worker layer is stateless and auto-scales.
- **Reads are KV/edge-cached.** Session, settings, and the public-skills catalog are KV reads near the user; the skills catalog is cached (1h TTL) so we don't hammer Orthogonal.
- **Spend is the one global invariant**, and it's enforced by the database, not app code (see concurrency below), so it stays correct as users multiply.
- **Bottlenecks** would be the upstream LLM and Orthogonal APIs, not our infra — which is exactly why the harness has timeouts, retries, and a circuit breaker, and why budget caps are hard limits.

### Context-window management

Two pressures: large API responses, and long history. Handled in four layers:

1. **Tool results are distilled.** `run_tool` returns a compact summary into the model's context (and only the summary + `requestId` is fed back to the model); the **full raw payload is stored out-of-context** in the DO (`raw_blobs`) and only pulled back via `expand_result(requestId)` if the summary is insufficient. So a 900KB enrichment response never blows the window — but the complete data is one fetch away.
2. **History is windowed.** `loadWindow` assembles the most-recent messages that fit a token budget (`HISTORY_BUDGET_TOKENS = 8000`, approximating tokens as chars/4), oldest-first, and never opens on an orphaned tool result whose parent call was trimmed.
3. **Rolling summary.** Older turns that age out of the window are folded into a running summary, injected as a system note, so multi-hour conversations stay bounded instead of growing unbounded.
4. **Images stay out of the transcript.** Vision attachments are sent on the turn the model needs them but are *not* written to the persisted message store — they'd bloat both the window and storage on every reload.

The per-call **output ceiling is 8192 tokens** — deliberately generous because "thinking" models (Gemini 3) spend output tokens on hidden reasoning *before* the answer; too small a ceiling truncates research answers mid-sentence.

### Persistence

Conversations live in their Durable Object's SQLite, keyed by conversation id and reachable from any device. The transcript is rehydrated on reconnect — including the tool-call messages with their requestIds, so cross-turn `expand_result` still works after you leave and return. Reopening a conversation also **reconstructs its agent-trace blocks from the stored transcript** — the collapsible `run_tool` / web steps come back with their api · path · status, price, latency, and a working "Open raw" — so a returning user sees the same chat they left, not just bare text. Accounts (email+password / Google) anchor identity; **chats and settings sync per workspace**, while BYOK API keys stay device-local and are never synced. Conversation titles are auto-summarized by a cheap model so the sidebar stays readable.

### Concurrency: many users hitting the same APIs

**The direct answer:** concurrent users never contend inside Ortha and can't overspend or corrupt one another; and within a turn, repeated calls to the *same* endpoint are collapsed and a failing one fails fast. Why:

- **Isolated by conversation.** Each conversation is its own Durable Object, so unrelated users and conversations run fully in parallel with **no shared in-process state to contend on** and no global lock or queue in the hot path. The Worker layer is stateless and auto-scales. (Within a single conversation, turns are serialized — one in-flight per DO — so there's no in-conversation race either.)
- **No overspend, enforced by the DB.** Spend is per-workspace: each tool call reserves budget with an atomic conditional `UPDATE` (`reserved + settled + new <= cap` in the `WHERE`). Concurrent reservations stay correct with no app-level lock — an over-cap one changes zero rows and is refused — so one user's burst can't blow another's cap or race the meter. Reserve → run → settle/refund releases a high estimate back.
- **Same endpoint, within a turn: dedupe + breaker.** The Orthogonal client wraps calls in an **in-flight dedupe cache** — identical concurrent `{api, path, body, query}` calls collapse into a single upstream request — and a **per-provider circuit breaker** (opens after 5 consecutive failures, 30s cooldown, half-open probe). So a turn that fans out to one endpoint neither sends N duplicate requests nor piles N callers into N timeouts against a struggling provider.
- **Honest scope + next step.** That dedupe cache and breaker live in the per-turn client instance, so today they protect *within* a conversation turn. A **shared, cross-user cache / rate-limiter / breaker** (in KV or a coordinator DO) is the next scaling step for fleet-wide protection of a single hot upstream — see [What I'd do with more time](#what-id-do-with-more-time).

### When an API is slow or down

**How the chat behaves:** it stays responsive and *always* resolves — you never get a hung spinner or an empty bubble. A slow call is abandoned at 30s; a failed call shows up as a failed step in the live trace; and the agent keeps going, trying a different endpoint or answering with what it already gathered. Under the hood:

- **Hard 30s timeout** per Orthogonal call (`AbortController`), matching the Worker fetch budget — a hanging upstream can't stall the turn.
- **Retry with backoff** for retryable *reads*; **writes are never retried** (`run` passes 0 retries) — an ambiguous timeout on a paid write must not double-charge.
- **Per-provider circuit breaker** opens after 5 repeated failures and short-circuits for a 30s cooldown, so the agent stops hammering a known-bad endpoint and routes elsewhere.
- **A failed tool never aborts the turn.** The error is fed back to the model as the tool result, so it self-corrects (different endpoint, or answer with what it has) instead of ending on an error.
- **Free web tools degrade gracefully.** A ~10s wall-clock cap per scrape (tighter than the 20s request timeout) keeps one slow page from stalling a research turn; known bot-walled hosts (LinkedIn, etc.) short-circuit instantly; multi-page reads run up to 4 in parallel; rate-limit/blocked results are non-fatal and fed back.
- **Long-running (submit→poll) endpoints** that can't finish in 30s (crawls, async deep-research) are refused up front rather than charged-then-aborted, and the agent picks a synchronous alternative.
- **Cost & side-effect gates** stream inline; declining cancels cleanly with nothing sent.

---

## Local development

```bash
bun install

# typecheck + tests (370+ unit tests across packages)
bun run typecheck
bun run test

# web (Vite dev server)
bun --cwd apps/web run dev

# worker (local, with Durable Objects + D1 + KV emulation)
bun --cwd apps/edge run dev
```

Deploy: `wrangler deploy` (worker) and `wrangler pages deploy dist --project-name ortha-web` (web). The worker needs `KV`, `DB` (D1), the `CONVERSATION_DO` Durable Object binding, and secrets (`KEY_ENCRYPTION_KEY`, optional `JINA_API_KEY`, optional `GOOGLE_CLIENT_ID/SECRET` for Google sign-in). Model + Orthogonal keys are BYOK via the UI, so no API keys are baked into the deploy.

---

## What I'd do with more time

- **Tool-selection determinism.** The same prompt can occasionally route to different catalog endpoints; I'd rank/pin endpoints per intent and cache the chosen endpoint per conversation so results are reproducible and costs predictable.
- **Fleet-wide upstream protection.** A shared, cross-user response cache + rate-limiter + circuit breaker (in KV or a coordinator DO) so identical calls across *different* users coalesce and a single hot/failing Orthogonal endpoint is throttled globally — today the dedupe cache and breaker are per conversation-turn.
- **Connectors.** The Connectors surface ships with a Gmail card scaffold; I'd finish the OAuth + give the agent a first-class Gmail tool (read/draft/send behind the existing side-effect gate).
- **Provider-error sanitization + auto-continue** on `max_tokens` so a truncated answer is transparently continued rather than relying solely on a generous ceiling.
- **Semantic retrieval over history** (embeddings) instead of a pure recency window, so older but relevant turns resurface.
- **Observability**: structured per-turn metrics (tool latency, cost, truncation rate) and dashboards; today the trace is per-conversation only.
- **Eval harness** for the agent loop (golden conversations for routing, grounding, recency) wired into CI.

---

## Testing

`bun run test` runs the unit suite (contracts mocks, the agent loop, provider adapters, budget/idempotency, context windowing, skills/title helpers). The deployed app is additionally exercised end-to-end over its real WebSocket against live Orthogonal + model APIs (auth, conversation persistence, tool execution, the cost/side-effect gates, skill install-and-run, and concurrent multi-conversation load).
