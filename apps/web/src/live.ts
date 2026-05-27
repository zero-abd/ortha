import type { PermissionResponse, TraceEvent } from "@ortha/contracts";
import { getDeviceId } from "./lib/config.ts";
import { getToken } from "./lib/auth.ts";
import type { TurnDeps } from "./types.ts";

export interface LiveDeps extends TurnDeps {
  conversationId: string;
}

/**
 * The inline result card renders the distilled summary. Parse JSON summaries into their
 * fields so the card shows structured data (e.g. {success, textId}) instead of a raw
 * string — and never the price: that's already shown as dollars in the trace line, and
 * the cents value (e.g. 2.5) next to "$0.03" only read as a contradiction.
 */
function structuredSummary(summary: string): unknown {
  try {
    const parsed: unknown = JSON.parse(summary);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* not JSON — fall through to a plain text record */
  }
  return { summary };
}

/**
 * Real transport: streams a turn from the deployed Conversation DO over WebSocket.
 * Mirrors the mock's deps so App is transport-agnostic. Rejects fast on connection
 * failure so the caller can fall back to the mock.
 */
export function runLiveTurn(text: string, deps: LiveDeps, apiBase: string, images?: readonly string[], deepResearch?: boolean, webSearch?: boolean): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const wsBase = apiBase.replace(/^http/, "ws");
    const token = encodeURIComponent(getToken() ?? "");
    const device = encodeURIComponent(getDeviceId());
    const ws = new WebSocket(`${wsBase}/api/conversations/${encodeURIComponent(deps.conversationId)}/stream?token=${token}&device=${device}`);
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
      ws.send(JSON.stringify({ type: "user_message", text, ...(images && images.length > 0 ? { images } : {}), ...(deepResearch ? { deepResearch: true } : {}), webSearch: webSearch !== false }));
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
      if (ev.type === "tool_result" && ev.requestId) deps.rawStore.set(ev.requestId, structuredSummary(ev.summary));
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
    const token = encodeURIComponent(getToken() ?? "");
    const device = encodeURIComponent(getDeviceId());
    const ws = new WebSocket(`${wsBase}/api/conversations/${encodeURIComponent(conversationId)}/stream?token=${token}&device=${device}`);
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
