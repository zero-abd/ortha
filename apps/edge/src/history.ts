// Reconstruct the inline agent-trace blocks for a reloaded conversation.
//
// When a conversation is re-opened from the sidebar, the client only had the live
// TraceEvent stream to build its trace blocks — that stream is gone on reconnect.
// All that survives is the persisted transcript (the `messages` table). This module
// rebuilds, from that transcript alone, the same per-turn trace steps the UI rendered
// live: each assistant turn's tool calls (api · path · status), with the requestId
// recovered so the "Open raw" affordance still works after a reload.
//
// priceCents / latencyMs ARE restored: the loop now stashes them on the tool result's
// persisted message (toolMeta), so a reopened block shows the same price + latency it did
// live. (Older conversations written before this change simply omit them — TraceBlock
// renders those fields conditionally, so the line still reads cleanly.)
//
// What is NOT recoverable (and is intentionally omitted):
//   - search_tools lines — emitted as free meta events, not paid tool calls; the
//     `search_tools` meta-tool turn is treated as internal plumbing and dropped.
//
// Kept as a pure function over the loaded Message[] so it unit-tests without a DO.

import type { Message } from "@ortha/contracts";

/** A reconstructed trace step. Structurally a subset of the web UI's TraceStep. */
export interface HistoryStep {
  readonly stepId: string;
  readonly api?: string;
  readonly path?: string;
  readonly status: "success" | "failed" | "running";
  readonly summary?: string;
  readonly requestId?: string;
  readonly priceCents?: number;
  readonly latencyMs?: number;
}

/** One restored chat turn: the plain bubble plus the trace steps that ran above it. */
export interface HistoryMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly steps?: HistoryStep[];
}

/** Tool names that produce a user-visible trace block we want to restore. */
const RESTORABLE_TOOLS = new Set(["run_tool", "web_search", "web_scrape"]);

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Derive the collapsed line's `api · path` for a restored step from the tool call's
 * name + args. Mirrors how the live loop labels each tool (loop.ts dispatch*):
 *   - run_tool   → api = args.api,  path = args.path
 *   - web_search → api = "web",     path = `search: "<query>"`
 *   - web_scrape → api = "web",     path = the url / "scrape N pages"
 */
function labelFor(name: string, args: Record<string, unknown>): { api?: string; path?: string } {
  if (name === "run_tool") {
    return { api: asString(args["api"]) ?? "orthogonal", path: asString(args["path"]) ?? "" };
  }
  if (name === "web_search") {
    const q = asString(args["query"]) ?? "";
    return { api: "web", path: `search: "${q}"` };
  }
  if (name === "web_scrape") {
    const url = asString(args["url"]);
    if (url) return { api: "web", path: url };
    const urls = Array.isArray(args["urls"]) ? (args["urls"] as unknown[]).filter((u) => typeof u === "string") : [];
    return { api: "web", path: urls.length === 1 ? String(urls[0]) : `scrape ${urls.length} pages` };
  }
  return {};
}

/**
 * Pull the requestId out of a persisted tool-result message. The live loop encodes it
 * in the result content as `… (requestId: <id>)` for a run_tool success; web tools
 * use a synthetic `web_step_*` id that isn't openable, so only real ones are surfaced.
 */
function extractRequestId(content: string): string | undefined {
  const m = content.match(/\(requestId:\s*([^)]+)\)/);
  return m?.[1]?.trim();
}

/**
 * Recover the distilled per-result summary the trace detail shows. A run_tool success
 * is `… → <summary> (requestId: <id>)`; take the slice after the arrow, trimmed of the
 * trailing requestId tag. Returns undefined when there's nothing meaningful to show.
 */
function extractSummary(content: string): string | undefined {
  const arrow = content.indexOf("→");
  if (arrow === -1) return undefined;
  const after = content.slice(arrow + 1).replace(/\s*\(requestId:\s*[^)]+\)\s*$/, "").trim();
  return after.length > 0 ? after : undefined;
}

/**
 * A persisted tool result signals failure when the loop wrote its failure feedback:
 *   run_tool:  "<api> <path> failed (<code>: <message>). …"
 *   web tools: "<tool> failed: <message>. …"
 * Both contain the token "failed". A success feedback is "run_tool … → <summary> …".
 */
function isFailure(content: string): boolean {
  return /\bfailed\b/.test(content) && !content.includes("→");
}

/**
 * Rebuild the visible chat history with reconstructed trace steps from a loaded
 * transcript window. Walks messages chronologically, accumulating each turn's tool
 * steps (assistant tool-call turns + their matching tool results), and attaches them
 * to that turn's visible assistant bubble — exactly where they render live.
 */
export function reconstructHistory(messages: readonly Message[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  let pending: HistoryStep[] = [];
  // call.id → index into `pending`, so a later tool result can finalize its step.
  const stepByCallId = new Map<string, number>();

  for (const m of messages) {
    if (m.role === "user") {
      // A user message opens a new turn; flush any orphaned steps (defensive) first.
      pending = [];
      stepByCallId.clear();
      out.push({ role: "user", content: m.content });
      continue;
    }

    if (m.role === "assistant") {
      // An assistant tool-call turn (content usually empty): register its steps.
      for (const tc of m.toolCalls ?? []) {
        if (!RESTORABLE_TOOLS.has(tc.name)) continue;
        const { api, path } = labelFor(tc.name, tc.args);
        stepByCallId.set(tc.id, pending.length);
        pending.push({ stepId: tc.id, status: "running", ...(api ? { api } : {}), ...(path ? { path } : {}) });
      }
      // The visible assistant bubble (actual answer text) closes the turn: attach the
      // accumulated steps above it, exactly as the live trace renders.
      if (m.content.trim().length > 0) {
        out.push({ role: "assistant", content: m.content, ...(pending.length > 0 ? { steps: pending } : {}) });
        pending = [];
        stepByCallId.clear();
      }
      continue;
    }

    if (m.role === "tool") {
      // Finalize the matching step from this result: status + requestId + summary.
      const idx = m.toolCallId ? stepByCallId.get(m.toolCallId) : undefined;
      if (idx === undefined) continue;
      const step = pending[idx];
      if (!step) continue;
      const failed = isFailure(m.content);
      const requestId = extractRequestId(m.content);
      const summary = extractSummary(m.content);
      pending[idx] = {
        ...step,
        status: failed ? "failed" : "success",
        ...(requestId ? { requestId } : {}),
        ...(summary ? { summary } : {}),
        ...(typeof m.priceCents === "number" ? { priceCents: m.priceCents } : {}),
        ...(typeof m.latencyMs === "number" ? { latencyMs: m.latencyMs } : {}),
      };
    }
  }

  return out;
}
