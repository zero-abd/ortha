import { useEffect, useMemo, useRef, useState } from "react";
import { matchCommands, parseSlash, runCommand, type Command, type CommandContext } from "../lib/commands.ts";

/**
 * ⌘K command palette. A fixed, centered, scrimmed dialog with a fuzzy-filter
 * input, arrow-key navigation, Enter to run, Esc to close, and a focus trap
 * (focus the input on open, restore on close). Reuses the modal scrim pattern.
 *
 * The host owns open/close; this component only renders when `open` is true and
 * resets its query/selection on each open.
 */
export function CommandPalette({ open, onClose, ctx }: { open: boolean; onClose: () => void; ctx: CommandContext }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  const results = useMemo(() => matchCommands(query), [query]);

  // Reset query/selection and focus the input on open; restore prior focus on close.
  useEffect(() => {
    if (open) {
      restoreFocus.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setActive(0);
      // Focus after paint so the input exists.
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      restoreFocus.current?.focus?.();
    }
  }, [open]);

  // Clamp the active index whenever the result set shrinks.
  useEffect(() => {
    setActive((a) => (results.length === 0 ? 0 : Math.min(a, results.length - 1)));
  }, [results.length]);

  // Keep the active row scrolled into view as you arrow through.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  if (!open) return null;

  const choose = (cmd: Command) => {
    const { arg } = parseSlash(query);
    runCommand(cmd, arg, ctx);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (results.length === 0 ? 0 : (a + 1) % results.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (results.length === 0 ? 0 : (a - 1 + results.length) % results.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = results[active];
      if (cmd) choose(cmd);
    } else if (e.key === "Tab") {
      // Focus trap: there is only the input, so keep focus on it.
      e.preventDefault();
    }
  };

  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="palette__search">
          <span className="palette__prompt" aria-hidden="true">/</span>
          <input
            ref={inputRef}
            className="palette__input"
            type="text"
            placeholder="Type a command or search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Command palette search"
            role="combobox"
            aria-expanded
            aria-controls="palette-list"
            aria-activedescendant={results[active] ? `palette-opt-${results[active].id}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {results.length === 0 ? (
          <div className="palette__empty">No matching commands.</div>
        ) : (
          <ul className="palette__list" id="palette-list" role="listbox" ref={listRef}>
            {results.map((cmd, i) => (
              <li
                key={cmd.id}
                id={`palette-opt-${cmd.id}`}
                role="option"
                aria-selected={i === active}
                className={`palette__opt${i === active ? " palette__opt--active" : ""}`}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(cmd)}
              >
                <span className="palette__opt-title">{cmd.title}</span>
                {cmd.argHint && <span className="palette__opt-arg">{cmd.argHint}</span>}
                <span className="palette__opt-desc">{cmd.description}</span>
                <span className={`palette__opt-kind palette__opt-kind--${cmd.kind}`}>{cmd.kind === "action" ? "action" : "prompt"}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="palette__foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
