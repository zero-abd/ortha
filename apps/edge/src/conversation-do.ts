import type { Env } from "./env.js";

/**
 * Conversation Durable Object — one instance per conversation id.
 *
 * STUB. Lane C replaces this with the Cloudflare Agents SDK `Agent` base class and
 * wires the locked design:
 *   - WebSocket token streaming + hibernation + resume (Agents SDK, free)
 *   - input serialization: blockConcurrencyWhile + per-conversation turn queue +
 *     cancel-or-queue policy (prevents two messages interleaving across awaits)
 *   - the portable orchestration loop (from @ortha/agent) invoked here
 *   - per-step checkpoint to ctx.storage.sql (source of truth for live state)
 *   - idempotent outbox flush of state to D1 (the queryable mirror)
 *
 * Kept as a plain SQLite-backed DO so `wrangler deploy` and the binding/migration
 * are valid today; swapping the base class is a lane-C change, not a rewrite.
 */
export class ConversationDO implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(_request: Request): Promise<Response> {
    // Touch ctx/env so the stub is shaped like the real thing.
    void this.ctx;
    void this.env;
    return Response.json({ ok: true, stub: "ConversationDO", todo: "lane C: Agents SDK + loop" });
  }
}
