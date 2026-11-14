import { useEffect, useRef, useState } from "react";

/** The element is inside an xterm.js terminal (which captures every key). */
export function isInTerminal(el: EventTarget | null): boolean {
  return el instanceof Element && el.closest(".xterm") !== null;
}

/** The user is typing: an input, textarea, select, contenteditable, or a terminal. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false;
  if (isInTerminal(el)) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el instanceof HTMLElement && (el.isContentEditable || el.closest('[contenteditable=""], [contenteditable="true"]'))) return true;
  return false;
}

interface Combo {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

function parseCombo(combo: string): Combo {
  const parts = combo.split("+");
  // "Ctrl++" style combos aren't used; the last part is the key.
  const key = parts.pop() ?? "";
  const mods = parts.map((p) => p.toLowerCase());
  return { ctrl: mods.includes("ctrl"), shift: mods.includes("shift"), alt: mods.includes("alt"), key: key.toLowerCase() };
}

/** The event is this combo. `Ctrl` also matches ⌘ (macOS). Shift is only checked for combos with modifiers. */
export function matchesCombo(e: KeyboardEvent, combo: string): boolean {
  const c = parseCombo(combo);
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl !== c.ctrl || e.altKey !== c.alt) return false;
  if (c.ctrl || c.alt) {
    if (e.shiftKey !== c.shift) return false;
  }
  const key = e.key.toLowerCase();
  return key === c.key || (c.key === "space" && e.key === " ");
}

export interface KeyOptions {
  enabled?: boolean;
  /** Also fire while typing in an input (never inside a terminal). */
  allowInInput?: boolean;
}

/** Calls `handler` on a window keydown matching `combo` ("s", "/", "Escape", "Ctrl+k", "Ctrl+Enter"). */
export function useKey(combo: string, handler: (e: KeyboardEvent) => void, opts: KeyOptions = {}): void {
  const { enabled = true, allowInInput = false } = opts;
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (isInTerminal(e.target)) return;
      if (!allowInInput && isTypingTarget(e.target)) return;
      if (!matchesCombo(e, combo)) return;
      ref.current(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [combo, enabled, allowInInput]);
}

/**
 * Keyboard row selection: j / ArrowDown and k / ArrowUp move, Enter calls `onOpen(index)`. Ignored while typing and
 * when Enter lands on a button or link (those handle it). The index is -1 until the first move.
 */
export function useListNav(
  count: number,
  opts: { onOpen(i: number): void; enabled?: boolean },
): [number, (i: number) => void] {
  const [index, setIndex] = useState(-1);
  const onOpen = useRef(opts.onOpen);
  onOpen.current = opts.onOpen;
  const enabled = opts.enabled ?? true;
  const indexRef = useRef(index);
  indexRef.current = index;
  // Read at key time, not captured by the listener: the listener is registered once (per `enabled`), so a key pressed
  // right after new rows rendered sees them even before React has run this render's passive effects.
  const countRef = useRef(count);
  countRef.current = count;

  useEffect(() => {
    if (index >= count) setIndex(count - 1);
  }, [count, index]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const count = countRef.current;
      if (count === 0) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((i) => Math.min(count - 1, i + 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => (i < 0 ? 0 : Math.max(0, i - 1)));
      } else if (e.key === "Enter") {
        const t = e.target;
        if (t instanceof Element && t.closest("button, a, [role='button']")) return;
        const i = indexRef.current;
        if (i >= 0 && i < count) {
          e.preventDefault();
          onOpen.current(i);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

  return [index, setIndex];
}
