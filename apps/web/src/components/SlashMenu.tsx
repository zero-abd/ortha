import { useEffect, useMemo, useRef, useState } from "react";
import { matchCommands, type Command } from "../lib/commands.ts";

/**
 * Inline slash menu shown above the composer when the draft starts with "/".
 * Filters by the typed command word, supports arrow-key navigation + Enter to
 * run, and exposes the active command so the composer's keydown handler can run
 * it. Rendered as a popover anchored to the composer (positioned by CSS).
 *
 * The composer keeps keyboard focus (so typing keeps working); this menu reads
 * the draft and reports selection back via callbacks.
 */
export function SlashMenu({
  query,
  registerNav,
  onChoose,
}: {
  /** The current draft (expected to start with "/"). */
  query: string;
  /**
   * Hands the parent imperative nav handlers (move/run/current) so the
   * composer's textarea keydown can drive selection without stealing focus.
   */
  registerNav: (nav: SlashNav | null) => void;
  /** Run the chosen command. */
  onChoose: (cmd: Command) => void;
}) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const results = useMemo(() => matchCommands(query), [query]);

  // Reset selection when the filtered set changes; clamp if it shrank.
  useEffect(() => {
    setActive((a) => (results.length === 0 ? 0 : Math.min(a, results.length - 1)));
  }, [results.length]);

  // Keep the active row visible.
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Expose nav to the parent for the duration this menu is mounted.
  useEffect(() => {
    if (results.length === 0) {
      registerNav(null);
      return () => registerNav(null);
    }
    const nav: SlashNav = {
      move: (dir) => setActive((a) => (a + dir + results.length) % results.length),
      run: () => {
        const cmd = results[active];
        if (cmd) onChoose(cmd);
      },
      hasResults: true,
    };
    registerNav(nav);
    return () => registerNav(null);
  }, [results, active, registerNav, onChoose]);

  if (results.length === 0) return null;

  return (
    <div className="slashmenu" role="listbox" aria-label="Slash commands">
      <ul className="slashmenu__list" ref={listRef}>
        {results.map((cmd, i) => (
          <li
            key={cmd.id}
            role="option"
            aria-selected={i === active}
            className={`slashmenu__opt${i === active ? " slashmenu__opt--active" : ""}`}
            onMouseMove={() => setActive(i)}
            onMouseDown={(e) => {
              // Prevent the textarea from losing focus before we run.
              e.preventDefault();
              onChoose(cmd);
            }}
          >
            <span className="slashmenu__title">{cmd.title}</span>
            {cmd.argHint && <span className="slashmenu__arg">{cmd.argHint}</span>}
            <span className="slashmenu__desc">{cmd.description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Imperative handle the composer uses to drive the menu from key events. */
export interface SlashNav {
  /** Move the active index by `dir` (+1 down, -1 up), wrapping. */
  move: (dir: number) => void;
  /** Run the currently active command. */
  run: () => void;
  /** Whether the menu currently has matches. */
  hasResults: boolean;
}
