import { useCallback, useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "gm.theme";
const QUERY = "(prefers-color-scheme: dark)";
const CHANGE_EVENT = "gm:theme";

function isPref(v: unknown): v is ThemePref {
  return v === "system" || v === "light" || v === "dark";
}

// The choice made on this page load when localStorage is unavailable, so the toggle still works until reload.
let memoryPref: ThemePref | undefined;

/** The saved preference, `system` when nothing (valid) is saved. */
export function getThemePref(): ThemePref {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return isPref(v) ? v : "system";
  } catch {
    return memoryPref ?? "system";
  }
}

function systemDark(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

/** The theme a preference shows now. */
export function resolveTheme(pref: ThemePref = getThemePref()): ResolvedTheme {
  if (pref === "system") return systemDark() ? "dark" : "light";
  return pref;
}

let mediaQuery: MediaQueryList | undefined;
const onSystemChange = () => {
  if (getThemePref() === "system") applyTheme();
};

/**
 * Sets `<html data-theme>` to the resolved theme, and while the preference is `system` follows the OS setting.
 * Call once before the first render; `setThemePref` calls it again.
 */
export function applyTheme(): ResolvedTheme {
  const resolved = resolveTheme();
  document.documentElement.dataset.theme = resolved;
  try {
    if (!mediaQuery && typeof window.matchMedia === "function") {
      mediaQuery = window.matchMedia(QUERY);
      mediaQuery.addEventListener?.("change", onSystemChange);
    }
  } catch {
    // No matchMedia: the theme just doesn't follow the OS.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return resolved;
}

/** Saves the preference (`system` removes the override) and applies it. */
export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, pref);
  } catch {
    // Storage blocked: the choice lasts until reload.
  }
  memoryPref = pref;
  applyTheme();
}

/** The preference, a setter, and the resolved theme; re-renders when either changes (also from the OS). */
export function useTheme(): { pref: ThemePref; setPref: (p: ThemePref) => void; resolved: ResolvedTheme } {
  const read = () => ({ pref: getThemePref(), resolved: (document.documentElement.dataset.theme as ResolvedTheme | undefined) ?? resolveTheme() });
  const [state, setState] = useState(read);
  useEffect(() => {
    const update = () => setState(read());
    window.addEventListener(CHANGE_EVENT, update);
    return () => window.removeEventListener(CHANGE_EVENT, update);
  }, []);
  const setPref = useCallback((p: ThemePref) => setThemePref(p), []);
  return { ...state, setPref };
}
