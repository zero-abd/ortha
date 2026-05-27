// The model registry is now a thin consumer of the single source of truth:
// `MODEL_CATALOG` + `DEFAULT_MODEL_ID` live in @ortha/contracts/models. Add or
// rename a model THERE, not here. This file only turns that catalog into a
// queryable registry (list/get/default) and lets tests inject a custom list.
import { DEFAULT_MODEL_ID, MODEL_CATALOG, type ModelInfo, type ModelRegistry } from "@ortha/contracts";

const MODELS: readonly ModelInfo[] = MODEL_CATALOG;

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
