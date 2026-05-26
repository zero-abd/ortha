// Provider catalog: a single source of truth maps the user-facing provider
// picker to concrete model ids. Settings.model is the persisted truth; the
// chat header and settings modal both read/write it through these helpers.

export interface ProviderInfo {
  id: string;
  label: string;
  defaultModel: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: "gemini", label: "Gemini", defaultModel: "gemini-2.5-flash" },
  { id: "anthropic", label: "Claude", defaultModel: "claude-3-5-haiku-latest" },
  { id: "openai", label: "OpenAI", defaultModel: "gpt-4o-mini" },
  { id: "openrouter", label: "OpenRouter", defaultModel: "meta-llama/llama-3.3-70b-instruct:free" },
];

/** Resolve which provider a model id belongs to (exact match, then prefix). */
export function providerOfModel(modelId: string): string {
  const exact = PROVIDERS.find((p) => p.defaultModel === modelId);
  if (exact) return exact.id;
  if (modelId.startsWith("gemini")) return "gemini";
  if (modelId.startsWith("claude")) return "anthropic";
  if (modelId.startsWith("gpt")) return "openai";
  if (modelId.includes("/")) return "openrouter";
  return "gemini";
}

/** Default model id for a provider, falling back to Gemini Flash. */
export function defaultModelOf(providerId: string): string {
  return PROVIDERS.find((p) => p.id === providerId)?.defaultModel ?? "gemini-2.5-flash";
}
