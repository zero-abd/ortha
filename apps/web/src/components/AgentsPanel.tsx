import { useState } from "react";
import type { AgentRun } from "../types.ts";
import { TraceBlock } from "./TraceBlock.tsx";
import { Spinner } from "./Logo.tsx";

/**
 * Right-docked Agents activity panel (toggleable, closed by default). Each agent
 * run — a chat turn or a batch row — is a small box showing live status; click a
 * box to expand its transcript (tool trace + streamed answer + any error).
 */

interface Props {
  runs: AgentRun[];
  open: boolean;
  onClose: () => void;
  onClear: () => void;
  onOpenRaw: (requestId: string) => void;
  rawStore: Map<string, unknown>;
}

export function AgentsPanel({ runs, open, onClose, onClear, onOpenRaw, rawStore }: Props) {
  if (!open) return null;
  const running = runs.filter((r) => r.status === "running").length;
  return (
    <aside className="agents" aria-label="Agent activity">
      <div className="agents__head">
        <span className="agents__title">
          Agents{running > 0 && <span className="agents__count">{running} running</span>}
        </span>
        <div className="agents__headactions">
          {runs.length > 0 && <button className="linkbtn" onClick={onClear}>Clear</button>}
          <button className="iconbtn" onClick={onClose} aria-label="Close agents panel">✕</button>
        </div>
      </div>
      <div className="agents__list">
        {runs.length === 0 ? (
          <div className="agents__empty">No agent activity yet. Ask Ortha something or run a batch — each task shows up here with its live trace.</div>
        ) : (
          runs.map((r) => <AgentCard key={r.id} run={r} onOpenRaw={onOpenRaw} rawStore={rawStore} />)
        )}
      </div>
    </aside>
  );
}

function elapsed(run: AgentRun): string {
  const secs = Math.max(0, Math.round(((run.endedAt ?? Date.now()) - run.startedAt) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function AgentCard({ run, onOpenRaw, rawStore }: { run: AgentRun; onOpenRaw: (id: string) => void; rawStore: Map<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const running = run.status === "running";
  return (
    <article className={`agentcard agentcard--${run.status}`}>
      <button className="agentcard__head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="caret agentcard__chev">{open ? "▾" : "▸"}</span>
        {running ? <Spinner size={13} /> : <span className={`agentcard__dot agentcard__dot--${run.status}`} aria-hidden />}
        <span className="agentcard__title" title={run.title}>{run.title}</span>
        <span className={`agentcard__badge agentcard__badge--${run.status}`}>{run.status}</span>
      </button>
      <div className="agentcard__meta mono">
        <span>{run.kind}</span>
        <span>· ${(run.costCents / 100).toFixed(2)}</span>
        <span>· {run.steps.length} step{run.steps.length === 1 ? "" : "s"}</span>
        <span>· {elapsed(run)}</span>
      </div>
      {open && (
        <div className="agentcard__body">
          {run.steps.map((s) => (
            <TraceBlock key={s.stepId} step={s} onOpenRaw={onOpenRaw} raw={s.requestId ? rawStore.get(s.requestId) : undefined} />
          ))}
          {run.answer && <div className="agentcard__answer">{run.answer}</div>}
          {run.error && <div className="agentcard__error">{run.error}</div>}
          {run.steps.length === 0 && !run.answer && !run.error && <div className="agentcard__pending mono">Starting…</div>}
        </div>
      )}
    </article>
  );
}
