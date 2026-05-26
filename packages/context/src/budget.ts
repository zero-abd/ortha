import type { LLMMessage, MemoryHit, ToolSpec } from "@ortha/contracts";
import { estimateTokens, messageTokens } from "./tokens.js";

export interface BuildContextWindowInput {
  /** The system prompt — ALWAYS kept, never dropped. */
  readonly system: string;
  /** Rolling summary of older turns, injected as a system note. May be null/empty. */
  readonly summary?: string | null;
  /** Retrieved prior turns/results (already ranked). Included only if budget allows. */
  readonly retrieved?: readonly MemoryHit[];
  /** Recent conversation messages, oldest-first. The latest is ALWAYS kept. */
  readonly recentMessages: readonly LLMMessage[];
  /** Tool schemas in play. Their token cost is reserved from the budget. */
  readonly toolSchemas?: readonly ToolSpec[];
  /** Hard ceiling on total estimated tokens for the assembled window. */
  readonly tokenBudget: number;
}

/**
 * Assemble the prompt within `tokenBudget` (approx tokens = chars/4).
 *
 * Priority, highest first:
 *   1. system            (always kept)
 *   2. latest message    (always kept — the thing we're responding to)
 *   3. rolling summary    (as a system note)
 *   4. remaining recent messages, newest → oldest
 *   5. retrieved hits, highest score → lowest
 *
 * Lower-priority items are dropped first. The returned LLMMessage[] is in natural
 * order (system, summary, retrieved, then messages oldest→newest) and its total
 * estimated token cost never exceeds `tokenBudget`. System + latest message are
 * preserved even when that means exceeding a pathologically tiny budget — they are
 * non-negotiable for a coherent request.
 */
export function buildContextWindow(input: BuildContextWindowInput): LLMMessage[] {
  const budget = Math.max(0, input.tokenBudget);

  const systemMsg: LLMMessage = { role: "system", content: input.system };

  // Tool schemas consume budget even though they aren't returned as messages.
  const toolReserve = (input.toolSchemas ?? []).reduce(
    (sum, t) => sum + estimateTokens(t.name) + estimateTokens(t.description) + estimateTokens(JSON.stringify(t.inputSchema)),
    0,
  );

  const recent = input.recentMessages;
  const latest = recent.length > 0 ? recent[recent.length - 1] : undefined;

  // ── Mandatory floor: system + latest message. Always present. ──
  let used = messageTokens(systemMsg) + toolReserve;
  if (latest) used += messageTokens(latest);

  let remaining = budget - used;

  // ── Optional summary note (priority 3). ──
  const summaryText = input.summary?.trim();
  let summaryMsg: LLMMessage | undefined;
  if (summaryText && summaryText.length > 0) {
    const candidate: LLMMessage = { role: "system", content: `Summary of earlier conversation:\n${summaryText}` };
    const cost = messageTokens(candidate);
    if (cost <= remaining) {
      summaryMsg = candidate;
      remaining -= cost;
    }
  }

  // ── Older recent messages (priority 4), newest → oldest, excluding the latest. ──
  const kept: LLMMessage[] = [];
  for (let i = recent.length - 2; i >= 0; i--) {
    const msg = recent[i];
    if (!msg) continue;
    const cost = messageTokens(msg);
    if (cost <= remaining) {
      kept.push(msg);
      remaining -= cost;
    }
    // Keep scanning older ones — a small older message may still fit.
  }
  kept.reverse(); // back to oldest → newest

  // ── Retrieved hits (priority 5), highest score → lowest. ──
  const retrievedMsgs: LLMMessage[] = [];
  for (const hit of input.retrieved ?? []) {
    const candidate: LLMMessage = { role: "system", content: `Relevant context:\n${hit.text}` };
    const cost = messageTokens(candidate);
    if (cost <= remaining) {
      retrievedMsgs.push(candidate);
      remaining -= cost;
    }
  }

  // ── Assemble in natural order. ──
  const out: LLMMessage[] = [systemMsg];
  if (summaryMsg) out.push(summaryMsg);
  out.push(...retrievedMsgs);
  out.push(...kept);
  if (latest) out.push(latest);
  return out;
}
