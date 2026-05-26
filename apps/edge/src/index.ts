import { ConversationDO } from "./conversation-do.js";
import type { Env } from "./env.js";

// The DO class must be exported from the Worker entry for the binding to resolve.
export { ConversationDO };

/**
 * Edge API Worker. Thin: auth + routing; delegates conversation work to the
 * per-conversation Durable Object. Lane C fills the real routes (REST + the
 * WS /stream endpoint), auth middleware, and DO delegation.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "ortha-edge" });
    }

    if (url.pathname.startsWith("/api/conversations")) {
      // TODO(lane C): resolve session → workspace, derive/lookup conversation id,
      // get the DO stub via env.CONVERSATION_DO.idFromName(conversationId), forward.
      void env;
      return Response.json({ todo: "lane C: route to ConversationDO", path: url.pathname }, { status: 501 });
    }

    return new Response("Ortha edge", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
