import { useCallback, useEffect, useState } from "react";
import type { ThemePreference } from "@ortha/contracts";

const KEY = "ortha.theme";

function readStored(): ThemePreference {
  if (typeof localStorage === "undefined") return "system";
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

function systemPrefersDark(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(pref: ThemePreference): "light" | "dark" {
  if (pref === "system") return systemPrefersDark() ? "dark" : "light";
  return pref;
}

/**
 * Theme follows system by default with a manual toggle, persisted to
 * localStorage (DESIGN.md §1). Applies resolved theme to <html data-theme>.
 */
export function useTheme() {
  const [pref, setPref] = useState<ThemePreference>(readStored);

  const applied = resolve(pref);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", applied);
  }, [applied]);

  // React to OS changes while in "system" mode.
  useEffect(() => {
    if (pref !== "system" || typeof matchMedia === "undefined") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () =>
      document.documentElement.setAttribute("data-theme", mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  const toggle = useCallback(() => {
    setPref((prev) => {
      const next: ThemePreference = resolve(prev) === "dark" ? "light" : "dark";
      if (typeof localStorage !== "undefined") localStorage.setItem(KEY, next);
      return next;
    });
  }, []);

  return { pref, applied, toggle };
}
