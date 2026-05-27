/**
 * Pure helpers that turn an arbitrary tool-result value into a small render
 * model (record / table / text) plus CSV and Markdown serializers.
 *
 * Tool results vary wildly: a single object, an array of flat objects, or an
 * envelope like `{ results: [...] }` / `{ data: ... }`. We normalize all of
 * these into one of three render kinds the ResultCard can draw. Cells holding
 * objects/arrays are JSON-stringified so a table stays rectangular and a record
 * stays a flat key/value list. The serializers operate purely on the render
 * model, so CSV/Markdown always match exactly what the card shows.
 */

/** A single key/value pair in a record view (the value is already a string). */
export interface ResultRow {
  k: string;
  v: string;
}

/** One object rendered as a flat key/value list. */
export interface RecordModel {
  kind: "record";
  rows: ResultRow[];
}

/** An array of flat objects rendered as a table. `rows` are stringified cells. */
export interface TableModel {
  kind: "table";
  columns: string[];
  rows: string[][];
}

/** Anything we can't structure (primitive, empty, ragged) falls back to text. */
export interface TextModel {
  kind: "text";
  text: string;
}

export type ResultModel = RecordModel | TableModel | TextModel;

/** A JS value that is rendered inline (not stringified into a JSON blob). */
function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** A plain object (excludes arrays and null) — the shape we treat as a record. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Render a single cell value: primitives as-is, null/undefined blank, else JSON. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (isPrimitive(v)) return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Unwrap common envelopes to the value worth rendering. `{ results: [...] }`,
 * `{ data: ... }`, and `{ items: [...] }` are the shapes Orthogonal tools tend
 * to return, so we look one level in for an array/object payload before giving
 * up and rendering the envelope itself.
 */
function unwrap(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  for (const key of ["results", "data", "items"]) {
    if (key in value) {
      const inner = value[key];
      if (Array.isArray(inner) || isPlainObject(inner)) return inner;
    }
  }
  return value;
}

/**
 * Build a render model from an arbitrary tool-result value.
 *
 * - array of plain objects -> table (column union, preserving first-seen order)
 * - single plain object     -> record (key/value list)
 * - everything else         -> text (pretty JSON for objects, raw for primitives)
 */
export function toModel(value: unknown): ResultModel {
  const v = unwrap(value);

  if (Array.isArray(v)) {
    if (v.length === 0) return { kind: "text", text: "[]" };
    // A table only makes sense when every element is a plain object. Otherwise
    // (array of primitives, or mixed) fall back to readable JSON.
    if (v.every(isPlainObject)) {
      const columns: string[] = [];
      for (const obj of v as Record<string, unknown>[]) {
        for (const key of Object.keys(obj)) {
          if (!columns.includes(key)) columns.push(key);
        }
      }
      if (columns.length === 0) return { kind: "text", text: stringify(v) };
      const rows = (v as Record<string, unknown>[]).map((obj) => columns.map((c) => cell(obj[c])));
      return { kind: "table", columns, rows };
    }
    return { kind: "text", text: stringify(v) };
  }

  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (keys.length === 0) return { kind: "text", text: "{}" };
    const rows: ResultRow[] = keys.map((k) => ({ k, v: cell(v[k]) }));
    return { kind: "record", rows };
  }

  // Primitive (or null/undefined) — render as plain text.
  if (v === null || v === undefined) return { kind: "text", text: "" };
  return { kind: "text", text: String(v) };
}

/** Pretty-print a value as JSON, tolerating cycles. */
function stringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Escape a single CSV field per RFC 4180 (quote when it contains , " \n \r). */
function csvField(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Serialize a render model to CSV. Record -> key,value rows; table -> grid. */
export function toCSV(model: ResultModel): string {
  if (model.kind === "table") {
    const head = model.columns.map(csvField).join(",");
    const body = model.rows.map((r) => r.map(csvField).join(",")).join("\n");
    return body ? `${head}\n${body}` : head;
  }
  if (model.kind === "record") {
    const head = "key,value";
    const body = model.rows.map((r) => `${csvField(r.k)},${csvField(r.v)}`).join("\n");
    return body ? `${head}\n${body}` : head;
  }
  // Text has no columnar structure; emit it as a single quoted field.
  return csvField(model.text);
}

/** Escape a Markdown table cell: pipes and newlines would break the grid. */
function mdCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Serialize a render model to GitHub-flavored Markdown. */
export function toMarkdown(model: ResultModel): string {
  if (model.kind === "table") {
    const head = `| ${model.columns.map(mdCell).join(" | ")} |`;
    const sep = `| ${model.columns.map(() => "---").join(" | ")} |`;
    const body = model.rows.map((r) => `| ${r.map(mdCell).join(" | ")} |`).join("\n");
    return body ? `${head}\n${sep}\n${body}` : `${head}\n${sep}`;
  }
  if (model.kind === "record") {
    const head = "| Field | Value |\n| --- | --- |";
    const body = model.rows.map((r) => `| ${mdCell(r.k)} | ${mdCell(r.v)} |`).join("\n");
    return body ? `${head}\n${body}` : head;
  }
  // Text falls back to a fenced code block so JSON stays readable.
  return "```\n" + model.text + "\n```";
}
