import { useEffect } from "react";
import { COARSE } from "./media";

/** More than any browser bar, less than any phone keyboard. */
export const KEYBOARD_MIN_PX = 120;

/** No browser says "the keyboard is open": it is when the visual viewport is much shorter than the window while an editable element has focus. */
export function isKeyboardOpen(vvHeight: number, innerHeight: number, activeIsEditable: boolean): boolean {
  return activeIsEditable && vvHeight < innerHeight - KEYBOARD_MIN_PX;
}

/** A visual viewport scale above this is a user pinch zoom, not the keyboard. */
export function isZoomed(scale: number | undefined): boolean {
  return typeof scale === "number" && scale > 1.01;
}

const NOT_TEXT = new Set(["button", "checkbox", "radio", "range", "submit", "reset", "file", "color", "image", "hidden"]);

/** Inputs that take text, textareas (also xterm's helper textarea) and contenteditable elements. */
export function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !NOT_TEXT.has(el.type);
  // jsdom has no isContentEditable; the attribute check covers it.
  return el instanceof HTMLElement && (el.isContentEditable === true || el.getAttribute("contenteditable") === "true");
}

/**
 * Call once (Shell). Keeps `--app-h` on <html> at the visual viewport height in px, toggles `kb-open` on <html>
 * while the on-screen keyboard is open, and on iOS scrolls the layout viewport back to the top.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport ?? null;
    // Android with interactive-widget=resizes-content shrinks innerHeight together with the visual viewport, so
    // compare against the tallest innerHeight seen at the current width (a width change is a rotation: start over).
    const coarse = () => typeof window.matchMedia === "function" && window.matchMedia(COARSE).matches;
    let tallest = { width: window.innerWidth, height: window.innerHeight };
    const update = () => {
      // Pinch zoom shrinks the visual viewport too. While zoomed, keep the last unzoomed size and don't pin the page.
      if (vv && isZoomed(vv.scale)) return;
      if (window.innerWidth !== tallest.width) tallest = { width: window.innerWidth, height: window.innerHeight };
      else if (window.innerHeight > tallest.height) tallest.height = window.innerHeight;
      const h = vv ? vv.height : window.innerHeight;
      root.style.setProperty("--app-h", `${Math.round(h)}px`);
      // Only touch screens have an on-screen keyboard; a desktop window made shorter is not one.
      const base = coarse() ? tallest.height : window.innerHeight;
      root.classList.toggle("kb-open", isKeyboardOpen(h, base, isEditable(document.activeElement)));
      // iOS pans the layout viewport up when an input near the bottom gets focus; the app is sized to the visual viewport, so pin it.
      if (vv && vv.offsetTop > 0) window.scrollTo(0, 0);
    };
    // During focusout the next element isn't focused yet.
    const later = () => window.setTimeout(update, 0);
    update();
    const target: EventTarget = vv ?? window;
    target.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", later);
    return () => {
      target.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", later);
      root.style.removeProperty("--app-h");
      root.classList.remove("kb-open");
    };
  }, []);
}
