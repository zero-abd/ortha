import type { PermissionResponse, TraceEvent } from "@ortha/contracts";
import { getWorkspaceId } from "./lib/config.ts";
import type { TurnDeps } from "./mock/transport.ts";

export interface LiveDeps extends TurnDeps {
  conversationId: string;
}

/**
 * Real transport: streams a turn from the deployed Conversation DO over WebSocket.
 * Mirrors the mock's deps so App is transport-agnostic. Rejects fast on connection
 * failure so the caller can fall back to the mock.
 */
export function runLiveTurn(text: string, deps: LiveDeps, apiBase: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const wsBase = apiBase.replace(/^http/, "ws");
    const wsId = encodeURIComponent(getWorkspaceId());
    const ws = new WebSocket(`${wsBase}/api/conversations/${encodeURIComponent(deps.conversationId)}/stream?ws=${wsId}`);
    let opened = false;
    const openTimer = setTimeout(() => {
      if (!opened) {
        try { ws.close(); } catch { /* noop */ }
        reject(new Error("ws open timeout"));
      }
    }, 4000);

    ws.addEventListener("open", () => {
      opened = true;
      clearTimeout(openTimer);
      ws.send(JSON.stringify({ type: "user_message", text }));
    });

    ws.addEventListener("message", (e) => {
      let ev: TraceEvent | { type: "history" };
      try {
        ev = JSON.parse(typeof e.data === "string" ? e.data : "{}");
      } catch {
        return;
      }
      if (ev.type === "history") return;
      if (ev.type === "permission_required") {
        void deps.requestPermission(ev).then((resp: PermissionResponse) => ws.send(JSON.stringify({ type: "permission", response: resp })));
        return;
      }
      if (ev.type === "tool_result" && ev.requestId) deps.rawStore.set(ev.requestId, { summary: ev.summary, priceCents: ev.priceCents });
      deps.onEvent(ev);
      if (ev.type === "done") {
        try { ws.close(); } catch { /* noop */ }
        resolve();
      }
    });

    ws.addEventListener("error", () => {
      if (!opened) {
        clearTimeout(openTimer);
        reject(new Error("ws connection failed"));
      }
    });
    ws.addEventListener("close", () => {
      if (opened) resolve();
    });
  });
}

/** Connect to a conversation's stream, grab its persisted history, and close. */
export function fetchHistory(conversationId: string, apiBase: string): Promise<{ role: string; content: string }[]> {
  return new Promise((resolve) => {
    const wsBase = apiBase.replace(/^http/, "ws");
    const wsId = encodeURIComponent(getWorkspaceId());
    const ws = new WebSocket(`${wsBase}/api/conversations/${encodeURIComponent(conversationId)}/stream?ws=${wsId}`);
    const finish = (msgs: { role: string; content: string }[]) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* noop */ }
      resolve(msgs);
    };
    const timer = setTimeout(() => finish([]), 4000);
    ws.addEventListener("message", (e) => {
      try {
        const ev = JSON.parse(typeof e.data === "string" ? e.data : "{}");
        if (ev.type === "history") finish(ev.messages ?? []);
      } catch {
        /* ignore */
      }
    });
    ws.addEventListener("error", () => finish([]));
  });
}
