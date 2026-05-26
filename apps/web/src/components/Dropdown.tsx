import { useEffect, useRef, useState } from "react";

export interface DropdownOption {
  value: string;
  label: string;
}

/**
 * Custom select: native <option> lists can't be styled (OS chrome, mismatched
 * font), so we render our own popover keyed off design tokens. Closes on
 * outside-click or Escape.
 */
export function Dropdown({
  value,
  options,
  onChange,
  ariaLabel,
  block,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (v: string) => void;
  ariaLabel: string;
  block?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div className={`dropdown${block ? " dropdown--block" : ""}`} ref={ref}>
      <button
        type="button"
        className="dropdown__trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dropdown__value">{current?.label ?? value}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <ul className="dropdown__menu" role="listbox" aria-label={ariaLabel}>
          {options.map((o) => (
            <li key={o.value} role="option" aria-selected={o.value === value}>
              <button
                type="button"
                className={`dropdown__opt${o.value === value ? " dropdown__opt--active" : ""}`}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span className="dropdown__opt-label">{o.label}</span>
                {o.value === value && <span className="dropdown__check">✓</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
