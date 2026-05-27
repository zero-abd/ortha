import { useEffect, useMemo, useState } from "react";
import { listSkills, type Skill } from "../lib/api.ts";
import { extractVars, fillTemplate } from "./SkillsModal.tsx";
import { batchToCSV, parseRows, runPool, type BatchRow, type RowResult } from "../lib/batch.ts";

/**
 * Batch mode — run one saved skill across many rows of input.
 *
 * Flow: pick a skill -> paste rows (one run per line) -> run. Each row fills the
 * skill template and runs as its own isolated turn (App injects `runRow`), with
 * a few in flight at once. Results stream into a table you can export as CSV.
 *
 * Reuses the .settings modal shell (mirrors SkillsModal / DiscoverModal).
 */

/** Max rows per batch — a guard rail against an accidental thousand-line paste. */
const MAX_ROWS = 50;
/** How many rows run at once. The harness dedupes/circuit-breaks; the workspace
 *  monthly cap bounds total spend, so a small pool is a good upstream citizen. */
const CONCURRENCY = 3;

type RowStatus = "queued" | "running" | "done" | "error";
interface RunRow {
  row: BatchRow;
  status: RowStatus;
  result?: RowResult;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Run one filled prompt as an isolated turn, resolving to its folded result.
   *  `label` is a short human title for the row (shown in the Agents panel). */
  runRow: (prompt: string, label?: string) => Promise<RowResult>;
}

/** Trigger a client-side file download from a string payload. */
function download(filename: string, mime: string, text: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function BatchModal({ open, onClose, runRow }: Props) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skill, setSkill] = useState<Skill | null>(null);
  const [rowsText, setRowsText] = useState("");
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  // Reset to a clean pick-screen only when the modal opens. This must NOT depend
  // on `running` — otherwise starting a run (which flips `running` to true) would
  // re-fire this effect and wipe the skill/rows/running state mid-batch.
  useEffect(() => {
    if (!open) return;
    setSkill(null);
    setRowsText("");
    setRuns([]);
    setRunning(false);
    void listSkills().then(setSkills);
  }, [open]);

  // Escape-to-close, guarded so it can't close mid-run. Kept separate so it can
  // depend on `running` without resetting any state.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !running) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, running]);

  const vars = useMemo(() => (skill ? extractVars(skill.template) : []), [skill]);
  const parsed = useMemo(() => (skill ? parseRows(rowsText, vars).slice(0, MAX_ROWS) : []), [skill, rowsText, vars]);

  if (!open) return null;

  const start = async () => {
    if (!skill || parsed.length === 0 || running) return;
    const initial: RunRow[] = parsed.map((row) => ({ row, status: "queued" }));
    setRuns(initial);
    setRunning(true);

    const patch = (i: number, next: Partial<RunRow>) =>
      setRuns((prev) => prev.map((r, j) => (j === i ? { ...r, ...next } : r)));

    await runPool(
      parsed,
      async (row, i) => {
        patch(i, { status: "running" });
        try {
          const result = await runRow(fillTemplate(skill.template, row.values), row.cells.join(" · ") || skill.name);
          patch(i, { status: result.ok ? "done" : "error", result });
        } catch (err) {
          patch(i, {
            status: "error",
            result: { answer: "", costCents: 0, ok: false, error: err instanceof Error ? err.message : "run failed" },
          });
        }
      },
      CONCURRENCY,
    );

    setRunning(false);
  };

  const reset = () => {
    setRuns([]);
    setRowsText("");
  };

  const totalCents = runs.reduce((sum, r) => sum + (r.result?.costCents ?? 0), 0);
  const doneCount = runs.filter((r) => r.status === "done" || r.status === "error").length;
  const hasResults = runs.length > 0;
  const csv = () => batchToCSV(vars, runs.map((r) => ({ cells: r.row.cells, result: r.result })));

  const copyCsv = () => {
    void navigator.clipboard?.writeText(csv()).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };

  const title = !skill ? "Batch run" : hasResults ? `Batch · ${skill.name}` : `Batch · ${skill.name}`;

  return (
    <div className="settings-scrim" onClick={() => !running && onClose()}>
      <div className="settings settings--lg" role="dialog" aria-modal="true" aria-label="Batch run" onClick={(e) => e.stopPropagation()}>
        <div className="settings__head">
          <span className="settings__title">{title}</span>
          <button className="iconbtn" onClick={onClose} disabled={running} aria-label="Close batch">✕</button>
        </div>

        <div className="settings__body">
          {/* Step 1 — pick a skill */}
          {!skill && (
            <div className="settings__section">
              <span className="settings__help">Pick a skill to run across a list of inputs. Each line becomes one run.</span>
              {skills.length === 0 ? (
                <div className="skill__empty">No skills yet. Create one in Skills first, then batch-run it here.</div>
              ) : (
                <div className="skill__list">
                  {skills.map((s) => (
                    <article className="skillcard" key={s.id}>
                      <div className="skillcard__main">
                        <span className="skillcard__name">{s.name}</span>
                        <p className="skillcard__template">{s.template}</p>
                      </div>
                      <div className="skillcard__actions">
                        <button className="btn-sm btn-sm--accent" onClick={() => setSkill(s)}>Select</button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step 2 — paste rows */}
          {skill && !hasResults && (
            <div className="settings__section">
              <div className="field">
                <span className="settings__sublabel">Skill</span>
                <div className="skill__preview">{skill.template}</div>
                <span className="settings__help">
                  {vars.length === 0
                    ? "This skill has no fields, so there's nothing to vary — add a {field} to batch it."
                    : vars.length === 1
                      ? <>One value per line for <span className="mono">{`{${vars[0]}}`}</span>.</>
                      : <>One row per line; separate {vars.length} values by comma or tab, in order: {vars.map((v) => <span className="mono" key={v}>{`{${v}}`} </span>)}</>}
                </span>
              </div>
              <div className="field">
                <span className="settings__sublabel">Rows</span>
                <textarea
                  className="input skill__template"
                  placeholder={vars.length <= 1 ? "stripe.com\nopenai.com\nanthropic.com" : "Stripe, payments\nOpenAI, ai"}
                  value={rowsText}
                  rows={7}
                  onChange={(e) => setRowsText(e.target.value)}
                  disabled={vars.length === 0}
                />
                <span className="settings__help">
                  {parsed.length} {parsed.length === 1 ? "row" : "rows"}
                  {parseRows(rowsText, vars).length > MAX_ROWS && ` (capped at ${MAX_ROWS})`}
                  {" · "}cost approvals auto-confirmed; write actions skipped.
                </span>
              </div>
              <div className="skill__formfoot">
                <button className="btn-sm" onClick={() => setSkill(null)}>Back</button>
                <button className="btn-sm btn-sm--accent" disabled={parsed.length === 0} onClick={() => void start()}>
                  Run {parsed.length || ""} {parsed.length === 1 ? "row" : "rows"}
                </button>
              </div>
            </div>
          )}

          {/* Step 3 — running + results */}
          {hasResults && (
            <div className="settings__section">
              <div className="batch__statusbar">
                <span className="settings__help">
                  {running ? `Running… ${doneCount}/${runs.length} done` : `Done · ${runs.length} ${runs.length === 1 ? "row" : "rows"}`}
                  {" · "}${(totalCents / 100).toFixed(2)} total
                </span>
                <div className="rcard__actions">
                  <button className="rcard__btn" onClick={copyCsv} disabled={running} title="Copy results as CSV">
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <button className="rcard__btn" onClick={() => download(`batch-${skill?.name ?? "run"}.csv`, "text/csv", csv())} disabled={running} title="Download CSV">
                    CSV
                  </button>
                </div>
              </div>
              <div className="rcard__tablewrap batch__tablewrap">
                <table className="rcard__table">
                  <thead>
                    <tr>
                      {vars.map((v) => <th key={v}>{v}</th>)}
                      <th>result</th>
                      <th>cost</th>
                      <th>status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r, i) => (
                      <tr key={i}>
                        {r.row.cells.map((c, j) => <td key={j} title={c}>{c}</td>)}
                        <td className="batch__resultcell" title={r.result?.error ?? r.result?.answer ?? ""}>
                          {r.result?.error ? <span className="batch__err">{r.result.error}</span> : (r.result?.answer ?? "")}
                        </td>
                        <td className="mono">{r.result ? `$${(r.result.costCents / 100).toFixed(2)}` : ""}</td>
                        <td><span className={`batch__badge batch__badge--${r.status}`}>{r.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="skill__formfoot">
                <button className="btn-sm" disabled={running} onClick={reset}>Run another</button>
                <button className="btn-sm btn-sm--accent" disabled={running} onClick={onClose}>Done</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
