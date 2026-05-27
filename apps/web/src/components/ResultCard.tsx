import { useMemo, useState } from "react";
import { toCSV, toMarkdown, toModel } from "../lib/resultFormat.ts";

interface Props {
  /** The raw tool-result value (from the rawStore). */
  raw: unknown;
  /** Optional label used for the downloaded file name (e.g. the provider/path). */
  title?: string | undefined;
}

/** How many table rows to show before the "show all" affordance kicks in. */
const ROW_CAP = 10;

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

/** Sanitize a title into a safe file slug; fall back to "result". */
function slug(title: string | undefined): string {
  const base = (title ?? "result").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "result";
}

/**
 * A clean, structured view of a tool result: key/value list for a single
 * object, a compact table for a list (capped at ROW_CAP with a "show all"
 * toggle), or a text block otherwise. Header actions copy the source data and
 * export it as CSV or Markdown.
 */
export function ResultCard({ raw, title }: Props) {
  const model = useMemo(() => toModel(raw), [raw]);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    const text = model.kind === "text" ? model.text : toCSV(model);
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };

  const name = slug(title);

  return (
    <div className="rcard">
      <div className="rcard__head">
        <span className="rcard__kind mono">
          {model.kind === "table" ? `${model.rows.length} rows` : model.kind === "record" ? "result" : "output"}
        </span>
        <div className="rcard__actions">
          <button className="rcard__btn" onClick={copy} title="Copy to clipboard">
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="rcard__btn" onClick={() => download(`${name}.csv`, "text/csv", toCSV(model))} title="Download as CSV">
            CSV
          </button>
          <button className="rcard__btn" onClick={() => download(`${name}.md`, "text/markdown", toMarkdown(model))} title="Download as Markdown">
            Markdown
          </button>
        </div>
      </div>
      <div className="rcard__body">
        <ResultBody model={model} showAll={showAll} onShowAll={() => setShowAll(true)} />
      </div>
    </div>
  );
}

function ResultBody({ model, showAll, onShowAll }: { model: ReturnType<typeof toModel>; showAll: boolean; onShowAll: () => void }) {
  if (model.kind === "record") {
    return (
      <dl className="rcard__record">
        {model.rows.map((r) => (
          <div className="rcard__kv" key={r.k}>
            <dt className="rcard__k">{r.k}</dt>
            <dd className="rcard__v">{r.v}</dd>
          </div>
        ))}
      </dl>
    );
  }

  if (model.kind === "table") {
    const visible = showAll ? model.rows : model.rows.slice(0, ROW_CAP);
    const hidden = model.rows.length - visible.length;
    return (
      <div className="rcard__tablewrap">
        <table className="rcard__table">
          <thead>
            <tr>
              {model.columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, i) => (
              <tr key={i}>
                {row.map((c, j) => (
                  <td key={j} title={c}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {hidden > 0 && (
          <button className="rcard__more linkbtn" onClick={onShowAll}>
            Show all {model.rows.length} rows
          </button>
        )}
      </div>
    );
  }

  return <pre className="rcard__text mono">{model.text}</pre>;
}
