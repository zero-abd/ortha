// Derive a compact "Sources" list from an assistant message's tool trace.
//
// Web steps carry their target in `path` (a scrape's `path` is the URL it read,
// a search's `path` is `search: "<query>"`) and a scrape's result `summary` is
// `read <url> (...)`. We collect the http(s) pages the agent READ, in the order
// the agent touched them, deduped. This is pure and transport-agnostic so it can
// be unit-tested without React.

import type { TraceStep } from "../types.ts";

export interface Source {
  url: string;
  domain: string;
}

/** Pull the bare hostname (sans leading `www.`) from a URL; falls back gracefully. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // Best-effort for strings the URL parser rejects: strip scheme + path.
    return url.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0] ?? url;
  }
}

/** True for a parseable absolute http(s) URL. */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** A scrape result summary looks like `read <url> (123 chars)`; pull out the URL. */
function urlFromSummary(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const m = /^read\s+(\S+)/.exec(summary.trim());
  return m && isHttpUrl(m[1]!) ? m[1] : undefined;
}

/**
 * Collect the unique http(s) pages the agent read from its web steps, in order.
 *
 * A scrape contributes its URL (from `path`, or parsed out of its `read <url>`
 * summary). Search steps carry only a query in `path`, so they contribute no
 * URL — when a turn only searched and never scraped, the result is empty.
 */
export function extractSources(steps: TraceStep[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const step of steps) {
    if (step.api !== "web") continue;
    const url =
      (step.path && isHttpUrl(step.path) ? step.path : undefined) ?? urlFromSummary(step.summary);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, domain: domainOf(url) });
  }
  return out;
}
