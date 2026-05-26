// Deterministic, model-free distillation fallback. Keeps fat provider JSON OUT of
// the LLM context: store the raw result by requestId, inject only this compact
// summary + a handle. (A model-assisted summary can replace this later.)
export interface Distilled {
  readonly summary: string;
  readonly rawBytes: number;
  readonly truncated: boolean;
}

export function distill(data: unknown, maxChars = 800): Distilled {
  let json: string;
  try {
    json = JSON.stringify(data) ?? String(data);
  } catch {
    json = String(data);
  }
  const rawBytes = json.length;
  if (rawBytes <= maxChars) {
    return { summary: json, rawBytes, truncated: false };
  }
  // Prefer top-level scalar fields, which are usually the useful bits.
  const scalars = topLevelScalars(data);
  const head = scalars.length > 0 ? scalars.join(" · ") : json.slice(0, maxChars);
  const summary = head.slice(0, maxChars);
  return { summary, rawBytes, truncated: true };
}

function topLevelScalars(data: unknown): string[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) {
      out.push(`${k}: ${String(v)}`);
    }
  }
  return out;
}
