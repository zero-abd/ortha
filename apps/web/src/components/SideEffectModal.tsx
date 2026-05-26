import { useEffect, useRef } from "react";
import { dollars } from "../lib/format.ts";

interface Props {
  action: string;
  target: string;
  estCents: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Deliberate confirm for side-effecting/irreversible tool calls (DESIGN.md §4). */
export function SideEffectModal({ action, target, estCents, onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="modal-scrim" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Confirm action" onClick={(e) => e.stopPropagation()}>
        <div className="modal__detail">
          <strong>{action}</strong>
          <div className="muted">{target}</div>
          <div className="muted">Estimated cost {dollars(estCents)} · this writes to the outside world and can't be undone.</div>
        </div>
        <div className="modal__actions">
          <button className="btn-sm" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-primary" ref={confirmRef} onClick={onConfirm}>
            <span className="btn-primary__label">Confirm</span>
          </button>
        </div>
      </div>
    </div>
  );
}
