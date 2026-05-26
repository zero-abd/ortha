import { createKeyVault } from "@ortha/auth";
import {
  type BudgetPolicy,
  type LLMProvider,
  type MemoryStore,
  type OrthogonalClient,
  type WorkspaceId,
} from "@ortha/contracts";
import { createBudgetPolicy, InMemorySpendStore } from "@ortha/budget";
import { createMemoryStore, mapKvPort, type ConvSummaryState } from "@ortha/context";
import { createOrthogonalClient, distill } from "@ortha/harness";
import { createAnthropicProvider, createOpenAICompatProvider, defaultModelRegistry } from "@ortha/llm";
import type { Env } from "./env.js";
import { kvStore } from "./kv.js";

export interface AgentPorts {
  llm: LLMProvider;
  orthogonal: OrthogonalClient;
  budget: BudgetPolicy;
  memory: MemoryStore;
  model: string;
}

const BASE_URLS: Record<"openai" | "openrouter" | "gemini", string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
};

/**
 * Build LIVE ports from a workspace's BYOK keys. Returns null when the required
 * keys aren't configured (or anything fails), so the DO falls back to demo mode —
 * a deploy can never break, and no spend happens without the user's own keys.
 */
export async function buildLivePorts(env: Env, ws: WorkspaceId): Promise<AgentPorts | null> {
  const vault = await createKeyVault({ masterKeyBase64: env.KEY_ENCRYPTION_KEY, store: kvStore(env.KV) });

  const orthoKey = await vault.getKey(ws, "orthogonal");
  if (!orthoKey) return null;

  const rawSettings = await env.KV.get(`settings:${ws}`);
  const settings = rawSettings ? (JSON.parse(rawSettings) as Partial<{ model: string; sessionCapCents: number; monthlyCapCents: number }>) : {};
  const model = settings.model ?? defaultModelRegistry.defaultModelId();
  const info = defaultModelRegistry.get(model);
  if (!info) return null;

  const llmKey = await vault.getKey(ws, info.provider);
  if (!llmKey) return null;

  let llm: LLMProvider;
  if (info.provider === "anthropic") {
    llm = createAnthropicProvider({ apiKey: llmKey });
  } else {
    llm = createOpenAICompatProvider({ providerId: info.provider, apiKey: llmKey, baseUrl: BASE_URLS[info.provider] });
  }

  const orthogonal = createOrthogonalClient({ getApiKey: async () => orthoKey });
  const budget = createBudgetPolicy({
    store: new InMemorySpendStore(),
    settings: { sessionCapCents: settings.sessionCapCents ?? 50, monthlyCapCents: settings.monthlyCapCents ?? 10_000 },
  });
  const memory = createMemoryStore({
    rawStore: mapKvPort<unknown>(),
    summaryStore: mapKvPort<ConvSummaryState>(),
    summarize: async (text: string) => distill(text).summary,
  });

  return { llm, orthogonal, budget, memory, model };
}
