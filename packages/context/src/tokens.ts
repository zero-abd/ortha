import type { LLMMessage } from "@ortha/contracts";

// Coarse token estimator. We never see the provider tokenizer here, so we use the
// well-worn heuristic of ~4 characters per token. Deliberately rounds UP so the
// budgeter is conservative and never sneaks over a hard ceiling.
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/** Estimated token cost of a message (role + content framing). */
export function messageTokens(message: LLMMessage): number {
  // The role string and message framing also cost tokens; fold in a small constant.
  return estimateTokens(message.content) + 1;
}
