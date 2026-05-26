import type { PermissionResponse } from "@ortha/contracts";
import { dollars } from "../lib/format.ts";

interface Props {
  stepId: string;
  estCents: number;
  sessionCents: number;
  capCents: number;
  /** True when the price is dynamic: estCents is a floor, the real charge may be higher. */
  dynamic?: boolean;
  resolved?: "approved" | "skipped";
  onDecide: (r: PermissionResponse) => void;
}

/** Inline spend-approval chip (DESIGN.md §4) — non-modal, keeps the flow. */
export function ApprovalChip({ stepId, estCents, sessionCents, capCents, dynamic, resolved, onDecide }: Props) {
  if (resolved) {
    return (
      <div className="chip chip--resolved">
        <span className="chip__head">{resolved === "approved" ? "Approved" : "Skipped"} a {dollars(estCents)} step.</span>
      </div>
    );
  }
  return (
    <div className="chip" role="group" aria-label="Spend approval">
      <div className="chip__head">
        Next step <span className="chip__cost">~{dollars(estCents)}{dynamic ? "+" : ""}</span>
        {dynamic ? <span className="chip__note"> · price varies</span> : null} · session {dollars(sessionCents + estCents)} / {dollars(capCents)} cap
      </div>
      <div className="chip__actions">
        <button className="btn-sm btn-sm--accent" onClick={() => onDecide({ stepId, decision: "approve" })}>
          Approve
        </button>
        <button className="btn-sm" onClick={() => onDecide({ stepId, decision: "raise_cap", newCapCents: capCents * 2 })}>
          Raise cap
        </button>
        <button className="btn-sm" onClick={() => onDecide({ stepId, decision: "skip" })}>
          Skip
        </button>
      </div>
    </div>
  );
}
