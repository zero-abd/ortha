import { useState } from "react";
import { dollars, ms } from "../lib/format.ts";
import type { TraceStep } from "../types.ts";
import { Spinner } from "./Logo.tsx";
import { ResultCard } from "./ResultCard.tsx";

const ICON: Record<TraceStep["status"], string> = {
  searching: "⊚", // ⊚
  running: "◴", // ◴
  success: "✓", // ✓
  failed: "✕", // ✕
  skipped: "–", // –
};

interface Props {
  step: TraceStep;
  onOpenRaw: (requestId: string) => void;
  /** The step's raw result payload (from the rawStore), if available. */
  raw?: unknown;
}

/** A raw value worth rendering as a card — anything but null/undefined. */
function hasStructuredRaw(raw: unknown): boolean {
  return raw !== null && raw !== undefined;
}

/** The signature inline agent-trace block: collapsed mono line, expandable detail. */
export function TraceBlock({ step, onOpenRaw, raw }: Props) {
  const [open, setOpen] = useState(false);
  const running = step.status === "running" || step.status === "searching";
  const label = step.api ? `${step.api} · ${step.path ?? ""}` : "searching tools…";
  const showCard = step.status === "success" && hasStructuredRaw(raw);

  return (
    <div className="trace">
      <button className="trace__line mono" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="caret trace__chev">{open ? "▾" : "▸"}</span>
        {running ? (
          <Spinner size={14} />
        ) : (
          <span className={`trace__icon--${step.status}`} aria-hidden>
            {ICON[step.status]}
          </span>
        )}
        <span>{label}</span>
        {step.priceCents !== undefined && <span className="trace__sep">· {dollars(step.priceCents)}</span>}
        {step.latencyMs !== undefined && <span className="trace__sep">· {ms(step.latencyMs)}</span>}
        <span className="trace__status sr-only">{step.status}</span>
      </button>

      {open && (
        <div className="trace__detail">
          {step.summary && <div className="trace__result-row">{step.summary}</div>}
          {step.tools && step.tools.length > 0 && (
            <ul className="trace__tools">
              {step.tools.map((t, i) => (
                <li key={t} className="mono">
                  {t}
                  {i === 0 && <span className="trace__tool-tag"> · recommended</span>}
                </li>
              ))}
            </ul>
          )}
          {showCard && <ResultCard raw={raw} title={step.api ?? step.path} />}
          {step.requestId && step.status === "success" && (
            <button className="linkbtn" onClick={() => onOpenRaw(step.requestId!)}>
              Open raw ↗
            </button>
          )}
        </div>
      )}

      {step.heal && (
        <div className="trace__heal mono">
          ↳ {step.heal.failed} failed → trying {step.heal.alt}
        </div>
      )}
    </div>
  );
}
