// Deep-research mode: wrap a user's question with a directive that pushes the
// agent toward thorough, multi-source web research instead of a quick answer.
//
// Frontend-only. The wrapped string is what the model receives for a turn; the
// chat bubble still shows the user's original text (see App.tsx `send`). The
// directive is tool-agnostic in spirit but names the web tools the agent
// already has (web_search / web_scrape) so it goes straight to using them.

/** Marker the wrapped prompt opens with — also used to detect prior wrapping. */
const RESEARCH_MARKER = "[Deep research mode]";

/**
 * Wrap `userText` with a deep-research directive. Keeps the original question
 * prominent and instructs the agent to search broadly, read the most relevant
 * results, cross-check, synthesize, cite every source URL, and flag any
 * uncertainty.
 *
 * Empty-safe: returns "" for blank input (caller shouldn't send a blank turn).
 * Idempotent-ish: if `userText` is already a wrapped prompt, it's returned
 * unchanged rather than double-wrapped.
 */
export function wrapResearch(userText: string): string {
  const question = userText.trim();
  if (!question) return "";
  if (question.startsWith(RESEARCH_MARKER)) return userText;

  return [
    RESEARCH_MARKER,
    "Do thorough, multi-source research to answer the question below. Specifically:",
    "- Run several web_search queries, broadening and rephrasing to cover different angles and sources.",
    "- Read the most relevant results in full with web_scrape — don't rely on search snippets alone.",
    "- Cross-check claims across multiple independent sources before stating them.",
    "- Answer with a structured summary (clear sections or bullet points) of what you found.",
    "- Cite every source URL you actually used inline and in a Sources list at the end.",
    "- Explicitly note any uncertainty, gaps, or conflicting information.",
    "",
    "Question:",
    question,
  ].join("\n");
}
