import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute("inert") && el.getAttribute("aria-hidden") !== "true");
}

/**
 * While `open`: moves focus into `ref` (the `[data-autofocus]` element, else the first focusable, else the container),
 * keeps Tab inside it, calls `onEscape` on Esc, and on close puts focus back on the element focused when it opened.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, open: boolean, onEscape: () => void): void {
  const escape = useRef(onEscape);
  escape.current = onEscape;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    if (root) {
      const first = root.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(root)[0] ?? root;
      first.focus();
    }
    const onKeyDown = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        escape.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables(el);
      if (items.length === 0) {
        e.preventDefault();
        el.focus();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === firstItem || !el.contains(active))) {
        e.preventDefault();
        lastItem?.focus();
      } else if (!e.shiftKey && (active === lastItem || !el.contains(active))) {
        e.preventDefault();
        firstItem?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (opener && opener.isConnected) opener.focus();
    };
  }, [open, ref]);
}
