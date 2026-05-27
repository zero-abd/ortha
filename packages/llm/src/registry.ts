// Curated model registry. Prices are integer cents per ONE MILLION tokens
// (matching ModelInfo.inputPerMTokensCents / outputPerMTokensCents — Cents is an
// integer-cent unit). Free-tier, tool-capable models are flagged `free: true`;
// the default model id is the cheapest free tool-capable one so dev/eval routing
// costs nothing while still exercising the tool path.
import type { ModelInfo, ModelRegistry } from "@ortha/contracts";

// Approximate public list prices, rounded to whole cents per million tokens.
// (e.g. $3.00 / Mtok input -> 300 cents). Kept conservative & easy to update.
const MODELS: readonly ModelInfo[] = [
  // --- Gemini (OpenAI-compat). Free tier available; tool-capable. ---
  {
    id: "gemini-2.5-flash",
    provider: "gemini",
    displayName: "Gemini 2.5 Flash",
    inputPerMTokensCents: 30, // ~$0.30 / Mtok
    outputPerMTokensCents: 250, // ~$2.50 / Mtok
    supportsToolUse: true,
    free: true,
  },
  {
    id: "gemini-2.5-flash-lite",
    provider: "gemini",
    displayName: "Gemini 2.5 Flash-Lite",
    inputPerMTokensCents: 10, // ~$0.10 / Mtok
    outputPerMTokensCents: 40, // ~$0.40 / Mtok
    supportsToolUse: true,
    free: true,
  },
  {
    id: "gemini-3-pro-preview",
    provider: "gemini",
    displayName: "Gemini 3 Pro",
    inputPerMTokensCents: 200, // ~$2.00 / Mtok (approx; update when GA pricing lands)
    outputPerMTokensCents: 1200, // ~$12.00 / Mtok
    supportsToolUse: true,
    free: false,
  },

  // --- Anthropic (native adapter). ---
  {
    id: "claude-3-5-sonnet-latest",
    provider: "anthropic",
    displayName: "Claude Sonnet",
    inputPerMTokensCents: 300, // ~$3.00 / Mtok
    outputPerMTokensCents: 1500, // ~$15.00 / Mtok
    supportsToolUse: true,
    free: false,
  },
  {
    id: "claude-3-5-haiku-latest",
    provider: "anthropic",
    displayName: "Claude Haiku",
    inputPerMTokensCents: 80, // ~$0.80 / Mtok
    outputPerMTokensCents: 400, // ~$4.00 / Mtok
    supportsToolUse: true,
    free: false,
  },

  // --- OpenAI (OpenAI-compat adapter). ---
  {
    id: "gpt-4o",
    provider: "openai",
    displayName: "GPT-4o",
    inputPerMTokensCents: 250, // ~$2.50 / Mtok
    outputPerMTokensCents: 1000, // ~$10.00 / Mtok
    supportsToolUse: true,
    free: false,
  },
  {
    id: "gpt-4o-mini",
    provider: "openai",
    displayName: "GPT-4o mini",
    inputPerMTokensCents: 15, // ~$0.15 / Mtok
    outputPerMTokensCents: 60, // ~$0.60 / Mtok
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

const DEFAULT_MODEL_ID = "gemini-2.5-flash";

export interface CreateModelRegistryOptions {
  /** Replace the curated list entirely (advanced / testing). */
  readonly models?: readonly ModelInfo[];
  /** Override the default model id. Must exist in the list. */
  readonly defaultModelId?: string;
}

export function createModelRegistry(options: CreateModelRegistryOptions = {}): ModelRegistry {
  const models = options.models ?? MODELS;
  const byId = new Map<string, ModelInfo>(models.map((m) => [m.id, m]));

  const requested = options.defaultModelId;
  const fallbackFree = models.find((m) => m.free && m.supportsToolUse);
  const defaultId =
    requested && byId.has(requested)
      ? requested
      : byId.has(DEFAULT_MODEL_ID)
        ? DEFAULT_MODEL_ID
        : (fallbackFree?.id ?? models[0]?.id ?? DEFAULT_MODEL_ID);

  return {
    list: () => models,
    get: (id: string) => byId.get(id),
    defaultModelId: () => defaultId,
  };
}

/** The curated default registry instance. */
export const defaultModelRegistry: ModelRegistry = createModelRegistry();
