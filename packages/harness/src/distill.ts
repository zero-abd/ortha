// Deterministic, model-free distillation fallback. Keeps fat provider JSON OUT of
// the LLM context: store the raw result by requestId, inject only this compact
// summary + a handle. (A model-assisted summary can replace this later.)
//
// The reducer is *structure-aware*: real provider payloads bury the answer in an
// array (search results, time-series candles, people lists) or under an envelope
// key (`data`, `output`, `results`). A scalar-only fallback throws all of that
// away. This descends through envelopes, finds the primary collection, and emits a
// bounded summary that keeps the salient content — item titles/links/snippets,
// answer-engine answers, or series statistics — regardless of how large the raw
// body is (a 412 KB payload still distills to a `maxChars`-bounded string).

export type DistilledKind = "passthrough" | "list" | "series" | "object" | "scalar";

export interface Distilled {
  /** What enters the LLM context. Always a non-empty string bounded to `maxChars`. */
  readonly summary: string;
  /** Byte length of the full JSON-encoded payload (pre-distillation). */
  readonly rawBytes: number;
  /** True when the summary is a reduction of a payload larger than `maxChars`. */
  readonly truncated: boolean;
  /** Which reduction path produced the summary. */
  readonly kind?: DistilledKind;
  /** For lists/series: number of items in the primary collection. */
  readonly count?: number;
  /** For lists: the reduced top-N item previews that the summary was built from. */
  readonly preview?: readonly string[];
  /** Salient top-level scalars kept alongside a collection (e.g. answer, query, total). */
  readonly scalars?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DistillOptions {
  readonly maxChars?: number;
  readonly previewItems?: number;
  readonly snippetChars?: number;
}

type Json = Record<string, unknown>;

// Wrapper keys whose lone child value is just an envelope around the real payload.
const ENVELOPE_KEYS = ["data", "output", "outputs", "result", "results", "brand"] as const;
// Keys whose array value is the primary collection, in priority order.
const COLLECTION_KEYS = [
  "results",
  "organic",
  "documents",
  "news",
  "items",
  "data",
  "hits",
  "places",
  "candles",
  "companies",
  "people",
] as const;
// Fields worth surfacing from an individual item, in priority order per group.
const TITLE_KEYS = ["title", "name", "company", "headline", "displayName", "fullName"] as const;
const LINK_KEYS = ["url", "link", "website", "domain", "permalink"] as const;
const SNIPPET_KEYS = ["snippet", "description", "summary", "text", "content", "abstract", "bio"] as const;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isScalar = (v: unknown): v is string | number | boolean | null =>
  v === null || ["string", "number", "boolean"].includes(typeof v);

export function distill(data: unknown, options: number | DistillOptions = {}): Distilled {
  // Back-compat: `distill(data, 800)` still works; the spec & callers pass a number.
  const opts: DistillOptions = typeof options === "number" ? { maxChars: options } : options;
  const maxChars = opts.maxChars ?? 800;
  const previewItems = opts.previewItems ?? 5;
  const snippetChars = opts.snippetChars ?? 160;

  let json: string;
  try {
    json = JSON.stringify(data) ?? String(data);
  } catch {
    json = String(data);
  }
  const rawBytes = json.length;

  // 1. Small payloads pass through untouched — the JSON *is* the summary.
  if (rawBytes <= maxChars) {
    return { summary: json, rawBytes, truncated: false, kind: "passthrough" };
  }

  // 2. Unwrap single-child envelopes, recording the path we descended.
  const { node, path } = unwrapEnvelopes(data);
  const prefix = path.length > 0 ? `${path.join(".")}: ` : "";

  // 3. Primary collection (named array, or a bare-root array).
  const collection = findCollection(node);
  if (collection) {
    return reduceList(collection.array, node, { maxChars, previewItems, snippetChars, prefix, rawBytes });
  }

  // 4. Array of numbers → time-series statistics.
  if (Array.isArray(node) && node.length > 0 && node.every((x) => typeof x === "number")) {
    return reduceSeries(node as number[], { maxChars, prefix, rawBytes });
  }

  // 5. Plain object, no collection → top-level scalars + one level into the largest nested object.
  if (isObject(node)) {
    return reduceObject(node, { maxChars, snippetChars, prefix, rawBytes });
  }

  // 6. Scalar / string root over maxChars → head+tail slice.
  return reduceScalar(node, { maxChars, prefix, rawBytes });
}

// --- envelope unwrapping -----------------------------------------------------

function unwrapEnvelopes(data: unknown): { node: unknown; path: string[] } {
  let node = data;
  const path: string[] = [];
  // Descend while the node is an object with exactly one key, and that key is a
  // known wrapper whose value is itself an object or array (the real payload).
  for (let guard = 0; guard < 8; guard++) {
    if (!isObject(node)) break;
    const keys = Object.keys(node);
    if (keys.length !== 1) break;
    const key = keys[0]!;
    if (!ENVELOPE_KEYS.includes(key as (typeof ENVELOPE_KEYS)[number])) break;
    const child = node[key];
    if (!isObject(child) && !Array.isArray(child)) break;
    path.push(key);
    node = child;
  }
  return { node, path };
}

// --- collection detection ----------------------------------------------------

function findCollection(node: unknown): { array: unknown[] } | null {
  if (Array.isArray(node)) {
    // A bare-root array of objects (or mixed) is itself the collection. Pure
    // number arrays are handled by the series path, so skip them here.
    if (node.length > 0 && node.every((x) => typeof x === "number")) return null;
    return { array: node };
  }
  if (!isObject(node)) return null;
  for (const key of COLLECTION_KEYS) {
    const v = node[key];
    if (Array.isArray(v) && v.length > 0) return { array: v };
  }
  return null;
}

// --- path 3: lists -----------------------------------------------------------

interface ListCtx {
  maxChars: number;
  previewItems: number;
  snippetChars: number;
  prefix: string;
  rawBytes: number;
}

function reduceList(array: unknown[], root: unknown, ctx: ListCtx): Distilled {
  const count = array.length;
  const preview = array.slice(0, ctx.previewItems).map((item, i) => reduceItem(item, i, ctx.snippetChars));
  // Answer-engine answers and query echoes are gold — keep top-level scalars too.
  const scalars = isObject(root) ? collectScalars(root) : {};
  const scalarParts = Object.entries(scalars).map(([k, v]) => `${k}: ${truncate(String(v), ctx.snippetChars)}`);

  const header = `${ctx.prefix}[${count} items]`;
  const parts = [header, ...scalarParts, ...preview];
  const summary = bound(parts.join("\n"), ctx.maxChars);
  return {
    summary,
    rawBytes: ctx.rawBytes,
    truncated: true,
    kind: "list",
    count,
    preview,
    scalars,
  };
}

function reduceItem(item: unknown, index: number, snippetChars: number): string {
  if (isScalar(item)) return `${index + 1}. ${truncate(String(item), snippetChars)}`;
  if (Array.isArray(item)) return `${index + 1}. [${item.length} items]`;
  if (!isObject(item)) return `${index + 1}.`;
  const title = firstString(item, TITLE_KEYS);
  const link = firstString(item, LINK_KEYS);
  const snippet = firstString(item, SNIPPET_KEYS);
  const bits: string[] = [];
  if (title) bits.push(truncate(title, snippetChars));
  if (link) bits.push(truncate(link, snippetChars));
  if (snippet && snippet !== title) bits.push(truncate(snippet, snippetChars));
  if (bits.length === 0) {
    // Fall back to the first few scalar fields so the item is never empty.
    const scalars = collectScalars(item);
    const entries = Object.entries(scalars).slice(0, 3);
    if (entries.length > 0) bits.push(entries.map(([k, v]) => `${k}: ${truncate(String(v), 60)}`).join(", "));
    else bits.push(`{${Object.keys(item).slice(0, 4).join(", ")}}`);
  }
  return `${index + 1}. ${bits.join(" — ")}`;
}

// --- path 4: time-series -----------------------------------------------------

function reduceSeries(nums: number[], ctx: { maxChars: number; prefix: string; rawBytes: number }): Distilled {
  const count = nums.length;
  let min = nums[0]!;
  let max = nums[0]!;
  let sum = 0;
  for (const n of nums) {
    if (n < min) min = n;
    if (n > max) max = n;
    sum += n;
  }
  const mean = sum / count;
  const first = nums[0]!;
  const last = nums[count - 1]!;
  const sample = nums.slice(0, 5).map((n) => trimNum(n));
  const summary = bound(
    `${ctx.prefix}series[${count}] first=${trimNum(first)} last=${trimNum(last)} ` +
      `min=${trimNum(min)} max=${trimNum(max)} mean=${trimNum(mean)} sample=[${sample.join(", ")}]`,
    ctx.maxChars,
  );
  return { summary, rawBytes: ctx.rawBytes, truncated: true, kind: "series", count };
}

// --- path 5: plain object ----------------------------------------------------

function reduceObject(
  obj: Json,
  ctx: { maxChars: number; snippetChars: number; prefix: string; rawBytes: number },
): Distilled {
  const scalars = collectScalars(obj);
  const parts = Object.entries(scalars).map(([k, v]) => `${k}: ${truncate(String(v), ctx.snippetChars)}`);

  // Recurse one level into the largest nested object to surface buried scalars.
  const nested = largestNestedObject(obj);
  if (nested) {
    const childScalars = collectScalars(nested.value);
    const childParts = Object.entries(childScalars)
      .slice(0, 8)
      .map(([k, v]) => `${nested.key}.${k}: ${truncate(String(v), ctx.snippetChars)}`);
    parts.push(...childParts);
  }

  const head = parts.length > 0 ? parts.join("\n") : "";
  // If the object had no scalars at all, fall back to a head+tail slice of the JSON
  // so the summary is never empty.
  let summary: string;
  try {
    summary = head.length > 0 ? bound(`${ctx.prefix}${head}`, ctx.maxChars) : sliceText(JSON.stringify(obj), ctx.maxChars);
  } catch {
    summary = sliceText(String(obj), ctx.maxChars);
  }
  return { summary, rawBytes: ctx.rawBytes, truncated: true, kind: "object", scalars };
}

// --- path 6: scalar / string root --------------------------------------------

function reduceScalar(node: unknown, ctx: { maxChars: number; prefix: string; rawBytes: number }): Distilled {
  const text = typeof node === "string" ? node : safeJson(node);
  const summary = bound(`${ctx.prefix}${sliceText(text, ctx.maxChars - ctx.prefix.length)}`, ctx.maxChars);
  return { summary, rawBytes: ctx.rawBytes, truncated: true, kind: "scalar" };
}

// --- helpers -----------------------------------------------------------------

function collectScalars(obj: Json): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isScalar(v)) out[k] = v;
  }
  return out;
}

function firstString(obj: Json, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return undefined;
}

function largestNestedObject(obj: Json): { key: string; value: Json } | null {
  let best: { key: string; value: Json; size: number } | null = null;
  for (const [k, v] of Object.entries(obj)) {
    if (!isObject(v)) continue;
    const size = safeJson(v).length;
    if (!best || size > best.size) best = { key: k, value: v, size };
  }
  return best ? { key: best.key, value: best.value } : null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

// Head+tail slice — keep the start and the end, drop the middle.
function sliceText(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max <= 8) return s.slice(0, max);
  const ellipsis = "…";
  const keep = max - ellipsis.length;
  const head = Math.ceil(keep * 0.7);
  const tail = keep - head;
  return `${s.slice(0, head)}${ellipsis}${tail > 0 ? s.slice(s.length - tail) : ""}`;
}

// Hard upper bound, applied after assembling any summary.
function bound(s: string, max: number): string {
  return s.length <= max ? s : sliceText(s, max);
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : Number(n.toFixed(4)).toString();
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
