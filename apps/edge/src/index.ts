import { ConversationDO } from "./conversation-do.js";
import type { Env } from "./env.js";

// The DO class must be exported from the Worker entry for the binding to resolve.
export { ConversationDO };

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
};

/**
 * Edge API Worker. Thin: routing + (future) auth; conversation work is delegated to
 * the per-conversation Durable Object, including the WebSocket /stream upgrade.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "ortha-edge" });
    }

    // Mint a conversation id; the DO is created lazily on first /stream connect.
    if (url.pathname === "/api/conversations" && request.method === "POST") {
      return json({ id: crypto.randomUUID() }, 201);
    }

    // WebSocket stream for a conversation → its Durable Object.
    const stream = url.pathname.match(/^\/api\/conversations\/([^/]+)\/stream$/);
    if (stream) {
      const name = decodeURIComponent(stream[1]!);
      const stub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(name));
      return stub.fetch(request);
    }

    return new Response("Ortha edge", { status: 200, headers: CORS });
  },
} satisfies ExportedHandler<Env>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}
