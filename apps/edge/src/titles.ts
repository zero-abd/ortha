// Conversation-title generation for the sidebar. Recent-chat titles should be short
// LLM summaries of the first prompt, not the raw (often long) prompt itself. Kept as
// small functions so the sanitize step is unit-testable without a live LLM provider.
import type { LLMProvider } from "@ortha/contracts";

/** Hard cap on a stored title's length (matches the old `text.slice(0, 60)`). */
const MAX_TITLE_CHARS = 60;

/**
 * System prompt for the cheap title-generation call. Asks for a bare 3-6 word
 * Title-Case summary so the result drops straight into the conversation index.
 */
export const TITLE_SYSTEM_PROMPT =
  "Summarize the user's request as a short 3-6 word title. " +
  "Output ONLY the title, no quotes, no punctuation at the end, Title Case.";

/** Hard ceiling on title-gen output. A 3-6 word title needs only a handful of tokens. */
const TITLE_MAX_TOKENS = 24;

/**
 * Normalize a raw model (or fallback) string into a clean sidebar title: strip
 * surrounding quotes, collapse whitespace/newlines to single spaces, drop a trailing
 * period, and cap the length. Returns "" when nothing usable remains so the caller
 * can fall back to the truncated prompt.
 */
export function sanitizeTitle(raw: string): string {
  let t = raw.replace(/\s+/g, " ").trim();
  // Strip a wrapping pair of single/double/smart quotes the model sometimes adds.
  t = t.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "").trim();
  // Drop trailing sentence punctuation (the prompt asks for none, but be defensive).
  t = t.replace(/[.!?,;:]+$/, "").trim();
  if (t.length > MAX_TITLE_CHARS) t = t.slice(0, MAX_TITLE_CHARS).trim();
  return t;
}

/**
 * Generate a concise conversation title from the user's first message via a cheap
 * LLM call (the workspace's configured model — defaults to a flash/free tier). Tokens
 * are collected from the stream into the title string. On any failure (or empty
 * result) returns the truncated `firstUserText`, so the sidebar always gets a title.
 */
export async function generateTitle(
  llm: LLMProvider,
  model: string,
  firstUserText: string,
): Promise<string> {
  const fallback = firstUserText.slice(0, MAX_TITLE_CHARS);
  try {
    let out = "";
    for await (const event of llm.streamCompletion({
      model,
      system: TITLE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: firstUserText }],
      tools: [],
      maxTokens: TITLE_MAX_TOKENS,
    })) {
      if (event.type === "token") out += event.text;
    }
    const title = sanitizeTitle(out);
    return title.length > 0 ? title : fallback;
  } catch {
    return fallback;
  }
}
