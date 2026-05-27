// ── THE single source of truth for model ids ────────────────────────────────
// Every model name in the app lives HERE. Adding, removing, or renaming a model
// is a one-file change: the LLM registry (pricing/provider resolution), the web
// provider picker, and every default-settings constant all derive from this.
//
// Gemini uses the `-latest` aliases on purpose: concrete preview ids
// (gemini-3-pro-preview, …) get retired by Google with no notice and then 404,
// whereas `gemini-pro-latest` / `gemini-flash-latest` always point at the current
// model. If Google ever moves an alias off the Gemini 3 generation, bump the
// displayName here — still one place.
import type { ModelInfo, ProviderId } from "./llm.js";

/** Every model the app can use. First entry per provider is that provider's default. */
export const MODEL_CATALOG: readonly ModelInfo[] = [
  // --- Gemini (OpenAI-compat). Tool-capable; `-latest` aliases for durability. ---
  {
    id: "gemini-flash-latest",
    provider: "gemini",
    displayName: "Gemini 3 Flash",
    inputPerMTokensCents: 30, // ~$0.30 / Mtok (approx)
    outputPerMTokensCents: 250, // ~$2.50 / Mtok
    supportsToolUse: true,
    free: true,
  },
  {
    id: "gemini-pro-latest",
    provider: "gemini",
    displayName: "Gemini 3 Pro",
    inputPerMTokensCents: 200, // ~$2.00 / Mtok (approx)
    outputPerMTokensCents: 1200, // ~$12.00 / Mtok
    supportsToolUse: true,
    free: false,
  },

  // --- Anthropic (native adapter). ---
  {
    id: "claude-3-5-haiku-latest",
    provider: "anthropic",
    displayName: "Claude Haiku",
    inputPerMTokensCents: 80, // ~$0.80 / Mtok
    outputPerMTokensCents: 400, // ~$4.00 / Mtok
    supportsToolUse: true,
    free: false,
  },
  {
    id: "claude-3-5-sonnet-latest",
    provider: "anthropic",
    displayName: "Claude Sonnet",
    inputPerMTokensCents: 300, // ~$3.00 / Mtok
    outputPerMTokensCents: 1500, // ~$15.00 / Mtok
    supportsToolUse: true,
    free: false,
  },

  // --- OpenAI (OpenAI-compat adapter). ---
  {
    id: "gpt-4o-mini",
    provider: "openai",
    displayName: "GPT-4o mini",
    inputPerMTokensCents: 15, // ~$0.15 / Mtok
    outputPerMTokensCents: 60, // ~$0.60 / Mtok
    supportsToolUse: true,
    free: false,
  },
  {
    id: "gpt-4o",
    provider: "openai",
    displayName: "GPT-4o",
    inputPerMTokensCents: 250, // ~$2.50 / Mtok
    outputPerMTokensCents: 1000, // ~$10.00 / Mtok
    supportsToolUse: true,
    free: false,
  },

  // --- OpenRouter (OpenAI-compat adapter). A free, tool-capable route. ---
  {
    id: "meta-llama/llama-3.3-70b-instruct:free",
    provider: "openrouter",
    displayName: "Llama 3.3 70B (free)",
    inputPerMTokensCents: 0,
    outputPerMTokensCents: 0,
    supportsToolUse: true,
    free: true,
  },
];

/** The default model id used wherever a workspace has not chosen one. */
export const DEFAULT_MODEL_ID = "gemini-flash-latest";

/** The default model for a provider = its first catalog entry (falls back to the global default). */
export function defaultModelForProvider(provider: ProviderId): string {
  return MODEL_CATALOG.find((m) => m.provider === provider)?.id ?? DEFAULT_MODEL_ID;
}
