// Boundary guards for the Conversation DO. Kept as small pure functions so they
// can be unit-tested in isolation (the DO itself needs a live DurableObjectState +
// WebSocket, which is awkward to construct in a unit test).
import * as agent from "@ortha/agent";

/**
 * Resolve the system-prompt text the agent runs with. A sibling change may rename
 * the `SYSTEM_PROMPT` const to a `buildSystemPrompt(now)` factory (so the prompt can
 * embed the current date). Import defensively: prefer the function form if it has
 * landed, otherwise fall back to the const. Either way we get the exact text the loop
 * passes as `system`, which is what the echo guard compares against.
 */
export function getSystemPromptText(now: Date = new Date()): string {
  const mod = agent as unknown as {
    buildSystemPrompt?: (now: Date) => string;
    SYSTEM_PROMPT?: string;
  };
  if (typeof mod.buildSystemPrompt === "function") return mod.buildSystemPrompt(now);
  return mod.SYSTEM_PROMPT ?? "";
}

/**
 * True when an incoming user_message carries no usable input: empty/whitespace-only
 * text AND no images. A message with images but blank text is meaningful (the model
 * can analyze the image), so it must NOT be treated as blank.
 */
export function isBlankInput(text: string, imageCount: number): boolean {
  return text.trim().length === 0 && imageCount === 0;
}

/** Shown to the client when a turn is rejected for having no usable input. */
export const EMPTY_INPUT_MESSAGE = "Type a message (or attach an image) to get started.";

/** Replaces an answer that's a near-verbatim dump of the system prompt. */
export const SYSTEM_PROMPT_REFUSAL =
  "I can't share my internal instructions, but I'm happy to help with your question.";

// ── Echo-guard thresholds ────────────────────────────────────────────────────
//
// We treat an answer as a system-prompt leak only on STRONG evidence, because a
// false positive silently swallows a legitimate answer. Two independent signals,
// either of which trips the guard:
//
//   1. A shared CONTIGUOUS run of >= MIN_CONTIGUOUS_RUN characters. A 200-char
//      verbatim block of our instructions is not something a normal answer ever
//      reproduces by chance — but a real "summarize/translate THIS document"
//      request copies the *user's* document, never our system prompt, so it stays
//      well clear of this. Contiguity matters: it's the difference between quoting
//      our rules verbatim and merely using the same common words.
//   2. >= MIN_COVERAGE_RATIO of the system prompt appearing verbatim, measured as
//      the longest shared contiguous run divided by the prompt length. This catches
//      a near-total dump of a (possibly short) prompt that the absolute 200-char
//      floor in (1) might miss.
//
// Both are deliberately HIGH so ordinary answers — including ones that happen to
// mention "web_search" or "Orthogonal" — never trip the guard.
const MIN_CONTIGUOUS_RUN = 200;
const MIN_COVERAGE_RATIO = 0.6;

/**
 * Length of the longest run of characters that appears contiguously in BOTH
 * `answer` and `prompt`. Cheap sliding compare: O(answer * prompt) worst case, but
 * the prompt is a fixed ~1.5KB and we early-exit once a run >= MIN_CONTIGUOUS_RUN is
 * found, so in practice it's a quick scan with no heavy deps. Comparison is
 * whitespace-collapsed + lowercased so trivial reformatting (a leak re-wrapped to
 * different line widths) can't slip past, without making the match fuzzy enough to
 * catch unrelated prose.
 */
function longestSharedRun(answer: string, prompt: string, cap: number): number {
  const a = normalizeForCompare(answer);
  const p = normalizeForCompare(prompt);
  if (a.length === 0 || p.length === 0) return 0;
  // Classic DP longest-common-substring, but with a 1-D rolling row so memory is
  // O(p) not O(a*p). We also stop the instant we reach `cap`, since callers only
  // care whether the run crosses a threshold, not its exact length beyond that.
  let prev = new Array<number>(p.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    const curr = new Array<number>(p.length + 1).fill(0);
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= p.length; j++) {
      if (ai === p.charCodeAt(j - 1)) {
        const run = prev[j - 1]! + 1;
        curr[j] = run;
        if (run > best) {
          best = run;
          if (best >= cap) return best;
        }
      }
    }
    prev = curr;
  }
  return best;
}

/** Lowercase + collapse all whitespace to single spaces. */
function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Decide whether `answer` is a near-verbatim echo of the system prompt — the
 * defense-in-depth signal that a prompt-injection attempt got the model to dump its
 * instructions. Uses a HIGH threshold (see the constants above) so normal answers,
 * including legitimate document summarize/translate requests, are never refused.
 */
export function isSystemPromptEcho(answer: string, systemPrompt: string): boolean {
  const normPrompt = normalizeForCompare(systemPrompt);
  if (normPrompt.length === 0) return false;
  // Nothing shorter than the contiguous floor can be a meaningful verbatim dump.
  if (normalizeForCompare(answer).length < MIN_CONTIGUOUS_RUN) {
    // ...unless the whole prompt itself is shorter than the floor, in which case we
    // fall back to the coverage ratio below.
    if (normPrompt.length >= MIN_CONTIGUOUS_RUN) return false;
  }
  const cap = Math.max(MIN_CONTIGUOUS_RUN, normPrompt.length);
  const run = longestSharedRun(answer, systemPrompt, cap);
  if (run >= MIN_CONTIGUOUS_RUN) return true;
  return run / normPrompt.length >= MIN_COVERAGE_RATIO;
}
