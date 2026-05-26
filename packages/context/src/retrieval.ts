import type { MemoryHit } from "@ortha/contracts";

// v1 retrieval: lowercase keyword-overlap ranking. No embeddings, no Vectorize.
// Score = (# of distinct query tokens present in the candidate) / (# distinct
// query tokens). A normalized 0..1 overlap is stable across candidate length and
// easy to reason about in tests.

const TOKEN_RE = /[a-z0-9]+/g;

/** Lowercase, split into alphanumeric word tokens, drop empties. */
export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(TOKEN_RE);
  return matches ?? [];
}

function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/** Fraction of the query's distinct tokens that appear in the candidate (0..1). */
export function overlapScore(queryTokens: Set<string>, candidate: string): number {
  if (queryTokens.size === 0) return 0;
  const candidateTokens = tokenSet(candidate);
  let hits = 0;
  for (const t of queryTokens) {
    if (candidateTokens.has(t)) hits++;
  }
  return hits / queryTokens.size;
}

/**
 * Rank `summaries` by keyword overlap with `query`, returning the top-`k` as
 * MemoryHits. Candidates with zero overlap are dropped. Ties keep insertion order
 * (newest-appended summaries should be passed later for a recency tiebreak).
 */
export function rankByOverlap(summaries: readonly string[], query: string, k: number): MemoryHit[] {
  if (k <= 0) return [];
  const queryTokens = tokenSet(query);
  const scored = summaries
    .map((text, index) => ({ text, index, score: overlapScore(queryTokens, text) }))
    .filter((s) => s.score > 0);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tiebreak: prefer the more recently appended summary (higher index).
    return b.index - a.index;
  });

  return scored.slice(0, k).map((s) => ({ text: s.text, score: s.score, source: "tool_result" as const }));
}
