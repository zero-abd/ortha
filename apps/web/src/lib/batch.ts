// Batch mode core: run one saved skill across many inputs.
//
// A skill is a reusable prompt (its SKILL.md). Batch mode runs that skill once
// per input line — each line is free text appended to the skill prompt, exactly
// like running the skill once from the composer (see `skillPrompt`). Each run is
// its own ephemeral conversation, so they run concurrently without contending,
// and each run's answer + cost + status is collected into an exportable table.
//
// Everything here is pure and transport-agnostic: the React modal injects the
// actual turn runner. That keeps the prompt building, the event→result fold, the
// concurrency pool, and the CSV serializer unit-testable without a WebSocket.

import type { TraceEvent } from "@ortha/contracts";

/**
 * Build the prompt for one skill run. Mirrors the composer's `/skill` path: the
 * skill's full text, with the free-text input (if any) appended below it. Shared
 * so a single run and a batch row produce byte-identical prompts.
 */
export function skillPrompt(template: string, input: string): string {
  const trimmed = input.trim();
  return trimmed ? `${template}\n\n${trimmed}` : template;
}

/** The folded outcome of running a single input's turn. */
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

/**
 * Parse pasted text into inputs — one run per non-blank line. Surrounding
 * whitespace is trimmed and blank lines are dropped; the whole line is the input
 * (commas and other punctuation are preserved — there are no fields to split on).
 */
export function parseRows(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
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
 * Serialize a finished (or partial) batch to CSV: the input, then the answer,
 * cost, and status. Rows still pending render as empty result cells so an
 * in-progress export is still well-formed.
 */
export function batchToCSV(rows: { input: string; result?: RowResult | undefined }[]): string {
  const header = ["input", "result", "cost_usd", "status"].map(csvField).join(",");
  const body = rows
    .map((r) => {
      const res = r.result;
      const tail = res ? [res.answer, dollars(res.costCents), res.ok ? "ok" : (res.error ?? "error")] : ["", "", "pending"];
      return [r.input, ...tail].map(csvField).join(",");
    })
    .join("\n");
  return body ? `${header}\n${body}` : header;
}
