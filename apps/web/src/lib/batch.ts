// Batch mode core: run one saved skill across many rows of input.
//
// A skill is a parameterized prompt template like "Enrich {company}: find the
// CEO and recent news." Batch mode fills that template once per row of pasted
// values, runs each as its own turn (in its own ephemeral conversation, so they
// can run concurrently without contending), and collects each turn's answer +
// cost + status into a table the user can export.
//
// Everything here is pure and transport-agnostic: the React modal injects the
// actual turn runner. That keeps the parsing, the event→result fold, the
// concurrency pool, and the CSV serializer unit-testable without a WebSocket.

import type { TraceEvent } from "@ortha/contracts";

/** One pasted row, mapped onto the skill's `{var}` names (first-seen order). */
export interface BatchRow {
  /** The original pasted line, kept for display/debugging. */
  line: string;
  /** Variable name -> filled value. */
  values: Record<string, string>;
  /** Values in `vars` order — what the results table and CSV show as inputs. */
  cells: string[];
}

/** The folded outcome of running a single row's turn. */
export interface RowResult {
  /** The assistant's final answer text (all streamed tokens concatenated). */
  answer: string;
  /** Total paid tool spend for this row, in cents. */
  costCents: number;
  /** True when the turn finished without an error event. */
  ok: boolean;
  /** Set when the turn surfaced an error (e.g. "TIMEOUT: upstream slow"). */
  error?: string;
}

/** Split a pasted line into cells: tab-delimited if any tab is present, else comma. */
function splitCells(line: string): string[] {
  return (line.includes("\t") ? line.split("\t") : line.split(",")).map((c) => c.trim());
}

/**
 * Parse pasted text into rows keyed by the skill's variables.
 *
 * - Blank lines are dropped.
 * - A single-variable skill treats each whole line as that variable's value
 *   (so commas inside the value are preserved).
 * - A multi-variable skill splits each line into cells (tab- or comma-delimited)
 *   and maps them onto the variables in first-seen order. Extra cells are
 *   ignored; missing cells become "".
 */
export function parseRows(text: string, vars: string[]): BatchRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.map((line) => {
    const cells = vars.length <= 1 ? [line] : splitCells(line);
    const values: Record<string, string> = {};
    vars.forEach((v, i) => {
      values[v] = (cells[i] ?? "").trim();
    });
    return { line, values, cells: vars.map((v) => values[v] ?? "") };
  });
}

/**
 * Fold a turn's streamed events into a single row result. Tokens concatenate
 * into the answer, successful tool results sum into the cost, and the first
 * error event flips the row to failed (mirrors the chat UI's own accounting).
 */
export function collectRow(events: TraceEvent[]): RowResult {
  let answer = "";
  let costCents = 0;
  let error: string | undefined;
  for (const e of events) {
    if (e.type === "token") answer += e.text;
    else if (e.type === "tool_result" && e.ok) costCents += e.priceCents;
    else if (e.type === "error" && !error) error = `${e.code}: ${e.message}`;
  }
  return { answer: answer.trim(), costCents, ok: !error, ...(error ? { error } : {}) };
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight at once.
 * Workers pull the next index off a shared cursor, so a slow row never blocks
 * a free lane. Resolves once every item has been processed; a worker is
 * expected to handle its own errors (this never rejects).
 */
export async function runPool<T>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let next = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: lanes }, run));
}

/** Escape one CSV field per RFC 4180 (quote when it holds , " or a newline). */
function csvField(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Format a cents amount as a plain dollar string for export (e.g. 3 -> "0.03"). */
function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Serialize a finished (or partial) batch to CSV: the skill's variable columns,
 * then the answer, cost, and status. Rows still pending render as empty result
 * cells so an in-progress export is still well-formed.
 */
export function batchToCSV(vars: string[], rows: { cells: string[]; result?: RowResult | undefined }[]): string {
  const header = [...vars, "result", "cost_usd", "status"].map(csvField).join(",");
  const body = rows
    .map((r) => {
      const res = r.result;
      const tail = res ? [res.answer, dollars(res.costCents), res.ok ? "ok" : (res.error ?? "error")] : ["", "", "pending"];
      return [...r.cells, ...tail].map(csvField).join(",");
    })
    .join("\n");
  return body ? `${header}\n${body}` : header;
}
