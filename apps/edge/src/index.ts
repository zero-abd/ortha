import { handleApi } from "./api.js";
import { handleAuth, resolveSession } from "./auth.js";
import { ConversationDO } from "./conversation-do.js";
import type { Env } from "./env.js";
import { CORS, json } from "./http.js";

// The DO class must be exported from the Worker entry for the binding to resolve.
export { ConversationDO };

/** One row of the per-workspace conversation index stored in KV (`conv-index:<ws>`). */
interface ConvIndexEntry {
  id: string;
  title: string;
  updatedAt: number;
}

/**
 * Edge API Worker. Thin: auth + routing. Conversation work (the WebSocket /stream
 * upgrade + the agent loop) is delegated to the per-conversation Durable Object.
 * Identity is a real account session (Bearer token); BYOK keys are device-scoped.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "ortha-edge" });
    }

    // Auth routes (signup/login/google/logout/me) are reachable without a session.
    const auth = await handleAuth(request, env, url);
    if (auth) return auth;

    // WebSocket stream → its Durable Object. Browsers can't set Authorization on a
    // WebSocket, so the DO authenticates the `?token=` itself; we just route by id.
    const stream = url.pathname.match(/^\/api\/conversations\/([^/]+)\/stream$/);
    if (stream) {
      const name = decodeURIComponent(stream[1]!);
      const stub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(name));
      return stub.fetch(request);
    }

    // Everything below requires a valid session.
    const session = await resolveSession(request, env);
    if (!session) return json({ error: "unauthorized" }, 401);

    // BYOK keys + settings + usage.
    const api = await handleApi(request, env, url, session);
    if (api) return api;

    // List this account's conversations (KV index the DO maintains, keyed by workspace).
    if (url.pathname === "/api/conversations" && request.method === "GET") {
      const raw = await env.KV.get(`conv-index:${session.workspaceId}`);
      return json({ conversations: raw ? JSON.parse(raw) : [] });
    }

    // Rename / delete a single conversation. The KV index (keyed by the validated
    // session's workspace) is the source of truth for the sidebar list, so both
    // operations mutate it directly here.
    const single = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (single && (request.method === "PATCH" || request.method === "DELETE")) {
      const id = decodeURIComponent(single[1]!);
      const key = `conv-index:${session.workspaceId}`;
      let list: ConvIndexEntry[] = [];
      try {
        const raw = await env.KV.get(key);
        if (raw) list = JSON.parse(raw) as ConvIndexEntry[];
      } catch {
        /* treat a corrupt index as empty */
      }

      if (request.method === "PATCH") {
        const body = (await request.json().catch(() => null)) as { title?: unknown } | null;
        const title = typeof body?.title === "string" ? body.title.trim() : "";
        if (!title) return json({ error: "title is required" }, 400);
        const next = list.map((c) => (c.id === id ? { ...c, title: title.slice(0, 200) } : c));
        await env.KV.put(key, JSON.stringify(next));
        return json({ ok: true });
      }

      // DELETE: drop the entry from the index, then best-effort wipe the DO's stored
      // messages so deleted conversations leave no data behind. We forward an
      // internal `?action=delete` (non-WebSocket) fetch to the same-named DO, which
      // clears its conversation-scoped SQLite rows. If that forward fails the DO is
      // simply orphaned (harmless): the sidebar only ever reads the KV index.
      const next = list.filter((c) => c.id !== id);
      await env.KV.put(key, JSON.stringify(next));
      try {
        const stub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(id));
        await stub.fetch(`https://do/api/conversations/${encodeURIComponent(id)}/?action=delete`, { method: "POST" });
      } catch {
        /* orphaned DO is harmless */
      }
      return json({ ok: true });
    }

    // Mint a conversation id; the DO is created lazily on first /stream connect.
    if (url.pathname === "/api/conversations" && request.method === "POST") {
      return json({ id: crypto.randomUUID() }, 201);
    }

    return new Response("Ortha edge", { status: 200, headers: CORS });
  },
} satisfies ExportedHandler<Env>;
