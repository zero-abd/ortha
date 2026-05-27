import { createKeyVault } from "@ortha/auth";
import {
  type BudgetPolicy,
  type LLMProvider,
  type MemoryStore,
  type OrthogonalClient,
  type WorkspaceId,
} from "@ortha/contracts";
import { createBudgetPolicy, InMemorySpendStore, type SpendStorePort } from "@ortha/budget";
import { DEFAULT_SETTINGS } from "@ortha/db";
import { createMemoryStore, mapKvPort, type ConvSummaryState, type KvPort } from "@ortha/context";
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
 * keys aren't configured (or anything fails), so the caller can surface a
 * "configure your keys" error. No spend ever happens without the user's own keys.
 */
export async function buildLivePorts(
  env: Env,
  ws: WorkspaceId,
  spendStore?: SpendStorePort,
  rawStore?: KvPort<unknown>,
): Promise<AgentPorts | null> {
  const vault = await createKeyVault({ masterKeyBase64: env.KEY_ENCRYPTION_KEY, store: kvStore(env.KV) });

  const orthoKey = await vault.getKey(ws, "orthogonal");
  if (!orthoKey) return null;

  const rawSettings = await env.KV.get(`settings:${ws}`);
  const settings = rawSettings
    ? (JSON.parse(rawSettings) as Partial<{ model: string; sessionCapCents: number; monthlyCapCents: number; perCallWarnCents: number }>)
    : {};
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
  const sessionCapCents = settings.sessionCapCents ?? DEFAULT_SETTINGS.sessionCapCents;
  const monthlyCapCents = settings.monthlyCapCents ?? DEFAULT_SETTINGS.monthlyCapCents;
  const perCallWarnCents = settings.perCallWarnCents ?? DEFAULT_SETTINGS.perCallWarnCents;
  // Durable store (D1 + DO SQLite) when the DO supplies one; else an in-memory
  // store seeded with the monthly cap so `remaining()` is correct from the start.
  const budget = createBudgetPolicy({
    store: spendStore ?? new InMemorySpendStore(() => monthlyCapCents),
    settings: { sessionCapCents, monthlyCapCents, perCallWarnCents },
  });
  // Durable, size-capped raw store (DO SQLite) when the DO supplies one; else the
  // in-memory per-turn Map. summaryStore stays in-memory for now.
  const memory = createMemoryStore({
    rawStore: rawStore ?? mapKvPort<unknown>(),
    summaryStore: mapKvPort<ConvSummaryState>(),
    summarize: async (text: string) => distill(text).summary,
  });

  return { llm, orthogonal, budget, memory, model };
}
