// Provider/model picker helpers. Model ids come from the ONE source of truth,
// `MODEL_CATALOG` in @ortha/contracts/models — never hardcode ids here. Settings.model
// is the persisted truth; the chat header and settings modal read/write it through
// these helpers.
import { DEFAULT_MODEL_ID, defaultModelForProvider, MODEL_CATALOG, type ModelInfo, type ProviderId } from "@ortha/contracts";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  defaultModel: string;
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  gemini: "Gemini",
  anthropic: "Claude",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

/** Providers that have at least one model in the catalog, with their default model. */
export const PROVIDERS: ProviderInfo[] = (["gemini", "anthropic", "openai", "openrouter"] as ProviderId[])
  .filter((id) => MODEL_CATALOG.some((m) => m.provider === id))
  .map((id) => ({ id, label: PROVIDER_LABELS[id], defaultModel: defaultModelForProvider(id) }));

/** Every model the user can pick, in catalog order. */
export const MODELS: readonly ModelInfo[] = MODEL_CATALOG;

/** All models for one provider (for a grouped model picker). */
export function modelsForProvider(providerId: ProviderId): readonly ModelInfo[] {
  return MODEL_CATALOG.filter((m) => m.provider === providerId);
}

/** Catalog entry for a model id (display name, provider, pricing). */
export function modelInfo(modelId: string): ModelInfo | undefined {
  return MODEL_CATALOG.find((m) => m.id === modelId);
}

/** Resolve which provider a model id belongs to (catalog match, then prefix). */
export function providerOfModel(modelId: string): ProviderId {
  const m = modelInfo(modelId);
  if (m) return m.provider;
  if (modelId.startsWith("gemini")) return "gemini";
  if (modelId.startsWith("claude")) return "anthropic";
  if (modelId.startsWith("gpt")) return "openai";
  if (modelId.includes("/")) return "openrouter";
  return "gemini";
}

/** Default model id for a provider, falling back to the global default. */
export function defaultModelOf(providerId: string): string {
  return PROVIDERS.find((p) => p.id === providerId)?.defaultModel ?? DEFAULT_MODEL_ID;
}
