import { handleApi } from "./api.js";
import { ConversationDO } from "./conversation-do.js";
import type { Env } from "./env.js";
import { CORS, json, workspaceOf } from "./http.js";

// The DO class must be exported from the Worker entry for the binding to resolve.
export { ConversationDO };

/**
 * Edge API Worker. Thin: routing + BYOK key/settings management; conversation work
 * (including the WebSocket /stream upgrade and the agent loop) is delegated to the
 * per-conversation Durable Object.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "ortha-edge" });
    }

    // BYOK keys + per-workspace settings.
    const api = await handleApi(request, env, url);
    if (api) return api;

    // List this workspace's conversations (from the KV index the DO maintains).
    if (url.pathname === "/api/conversations" && request.method === "GET") {
      const ws = workspaceOf(request);
      if (!ws) return json({ error: "missing or invalid x-ortha-workspace header" }, 400);
      const raw = await env.KV.get(`conv-index:${ws}`);
      return json({ conversations: raw ? JSON.parse(raw) : [] });
    }

    // Mint a conversation id; the DO is created lazily on first /stream connect.
    if (url.pathname === "/api/conversations" && request.method === "POST") {
      return json({ id: crypto.randomUUID() }, 201);
    }

    // WebSocket stream for a conversation → its Durable Object. The ?ws=<workspace>
    // query (and the path id) are forwarded to the DO, which reads them for BYOK.
    const stream = url.pathname.match(/^\/api\/conversations\/([^/]+)\/stream$/);
    if (stream) {
      const name = decodeURIComponent(stream[1]!);
      const stub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(name));
      return stub.fetch(request);
    }

    return new Response("Ortha edge", { status: 200, headers: CORS });
  },
} satisfies ExportedHandler<Env>;
