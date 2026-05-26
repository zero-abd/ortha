# Ortha — continue from a new machine

Everything is on `main`. Clone it, then:

## 1. Toolchain + deps
```bash
# Install bun (the package manager + runtime) if you don't have it:
#   macOS/Linux: curl -fsSL https://bun.sh/install | bash
#   Windows:     powershell -c "irm bun.sh/install.ps1 | iex"
bun install            # monorepo workspaces, from the repo root
bun run typecheck      # tsc --build across all packages  (should be clean)
bun run test           # vitest — 166 pass + 3 skipped (gated live tests)
```

## 2. Run the app locally
```bash
cd apps/web && bun run dev     # Vite dev server (http://localhost:5173)
```
The web app points at the **deployed** worker by default (`VITE_ORTHA_API`), so local web + prod backend works with zero config. To run the worker locally too: `cd apps/edge && bunx wrangler dev`, then set `VITE_ORTHA_API=http://127.0.0.1:8787` for the web.

By default the app runs in **demo mode**: the real agent loop with mock data — no keys, no spend. To use **live mode**, open **Settings** in the app and add an Orthogonal key + one provider key (Gemini / OpenAI / OpenRouter / Anthropic), then pick that provider. Keys are encrypted at rest and scoped to your browser's workspace id (localStorage `ortha.workspace`).

## 3. Deploy (needs Cloudflare auth)
```bash
bunx wrangler login                       # one-time, your Cloudflare account
# Worker (API + Durable Object):
cd apps/edge && bun run deploy            # -> https://ortha-edge.<acct>.workers.dev
# Web (Cloudflare Pages):
cd apps/web && bun run build
bunx wrangler pages deploy dist --project-name=ortha-web --branch=main
```
Live deployments:
- Web:    https://ortha-web.pages.dev
- Worker: https://ortha-edge.almahmud-zero.workers.dev

## 4. Secrets & resources (already provisioned in Cloudflare)
These live in **Cloudflare, not the repo** — you do NOT need them for normal dev:
- **`KEY_ENCRYPTION_KEY`** — Worker secret (AES-GCM master key for the BYOK vault). Already set on the deployed worker. Only re-set it if you recreate the worker: `cd apps/edge && bunx wrangler secret put KEY_ENCRYPTION_KEY`. **Do not change its value** — previously stored BYOK keys can only be decrypted with the same key.
- Bindings (in `apps/edge/wrangler` config): `CONVERSATION_DO` (Durable Object, SQLite-backed), `KV` (settings + BYOK keys + conversation index), `DB` (D1 `ortha`, workspace monthly spend).
- **BYOK provider keys** are stored encrypted per-workspace in KV via the Settings UI — never in the repo.

## 5. Security note
The temporary Orthogonal + Gemini keys used during development were shared in chat — **revoke them**. The test workspace `livedo-test-001` in KV still holds encrypted copies; rotate the keys on the provider side to be safe.

## 6. What's left (suggested next work)
- **L3–L9 harness robustness** — see `docs/harness-plans/00-MASTER-PLAN.md`: surface dynamic pricing to the budget gate, wire the `side_effect` permission gate (+ verb-based classification), map HTTP 422 / lift structured upstream errors / `maybeBilled` flag, key the price index by `method+path`, coerce GET query params to strings, pre-flight required-param validation.
- **Full QA pass** of every user flow (multi-conversation, settings, Discover, cost meter, light/dark) with the live keys, fixing any bugs.
- **UI/UX polish** across the app.

## Repo map
- `apps/web` — React + Vite console (Cloudflare Pages)
- `apps/edge` — Cloudflare Worker + `ConversationDO` (the agent loop runs here, streams over WebSocket)
- `packages/agent` — portable agent loop (meta-tools: search_tools / get_tool_details / run_tool / expand_result)
- `packages/harness` — Orthogonal API client (search/details/run, retry, circuit breaker, dedupe, distill)
- `packages/llm` — Anthropic + OpenAI-compat (OpenAI/OpenRouter/Gemini) adapters + model registry
- `packages/budget` — spend policy (reserve/settle/refund, session + monthly caps, per-call warn)
- `packages/context` — memory store + context-window budgeting + size-capped raw store
- `packages/db` — SQLite-backed ConversationStore (messages, tool transcript, journal, settings)
- `packages/contracts` — shared types + zod wire schemas + mocks
- `docs/harness-plans` — limitations + handling plans from the live API probes
