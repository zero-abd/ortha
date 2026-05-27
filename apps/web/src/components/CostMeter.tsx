import { useState } from "react";
import { dollars } from "../lib/format.ts";

interface Props {
  sessionCents: number;
  capCents: number;
  breakdown: { api: string; cents: number }[];
}

/** Top-bar spend meter: calm by default, amber at 80% of cap, red at 100%. Always real spend. */
export function CostMeter({ sessionCents, capCents, breakdown }: Props) {
  const [open, setOpen] = useState(false);
  const ratio = capCents > 0 ? sessionCents / capCents : 0;
  const level = ratio >= 1 ? "danger" : ratio >= 0.8 ? "warn" : "ok";
  const mod = level === "ok" ? "" : `--${level}`;

  return (
    <div className="cost">
      <button className="cost__btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Session spend">
        <span className={`cost__dot cost__dot${mod}`} aria-hidden />
        <span className="cost__dollars">{`${dollars(sessionCents)} / ${dollars(capCents)}`}</span>
        <span className="cost__bar" aria-hidden>
          <span className={`cost__fill cost__fill${mod}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </span>
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Spend breakdown">
          <div className="breakdown">
            {breakdown.length === 0 && <div className="breakdown__row muted">No spend yet this session.</div>}
            {breakdown.map((b, i) => (
              <div className="breakdown__row" key={i}>
                <span className="breakdown__api mono">{b.api}</span>
                <span>{dollars(b.cents)}</span>
              </div>
            ))}
            <div className="breakdown__row breakdown__row--total">
              <span>Session total</span>
              <span>{dollars(sessionCents)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
