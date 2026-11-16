/** The part of an xterm Terminal that touch handling needs (a real Terminal fits). */
export interface TouchTerm {
  focus(): void;
  readonly element: HTMLElement | undefined;
  readonly rows: number;
  scrollLines(amount: number): void;
}

/** A touch that moved less than this is a tap. */
export const TAP_PX = 10;

interface Gesture {
  id: number;
  x0: number;
  y0: number;
  lastY: number;
  swiping: boolean;
  /** Wheel pixels not yet turned into whole scrollback lines. */
  acc: number;
}

/**
 * Touch on a terminal: a tap focuses it (inside the gesture, so iOS opens the keyboard), a swipe scrolls it.
 * Mouse and pen are left to xterm. Returns a dispose function.
 */
export function attachTouch(host: HTMLElement, term: TouchTerm, opts: { onTap?: () => void } = {}): () => void {
  let g: Gesture | null = null;

  const down = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    // A second finger: not a tap and not a one-finger scroll.
    if (g) {
      if (e.pointerId !== g.id) g = null;
      return;
    }
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lastY: e.clientY, swiping: false, acc: 0 };
  };

  const move = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || !g || e.pointerId !== g.id) return;
    if (!g.swiping && Math.hypot(e.clientX - g.x0, e.clientY - g.y0) >= TAP_PX) g.swiping = true;
    if (!g.swiping) return;
    e.preventDefault();
    const dy = e.clientY - g.lastY;
    g.lastY = e.clientY;
    if (dy === 0) return;
    // xterm's own wheel handling covers mouse mode (TUIs) and the alt buffer; it cancels the event when it acts.
    const ev = new WheelEvent("wheel", { deltaY: -dy, deltaMode: 0, bubbles: true, cancelable: true });
    const unhandled = term.element?.dispatchEvent(ev) ?? true;
    if (!unhandled) return;
    // Normal buffer: xterm scrolls it from an inner node the event never reaches, so scroll the scrollback here.
    g.acc += -dy;
    const cell = (term.element?.clientHeight || 0) / Math.max(1, term.rows) || 17;
    const lines = Math.trunc(g.acc / cell);
    if (lines !== 0) {
      term.scrollLines(lines);
      g.acc -= lines * cell;
    }
  };

  const up = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || !g || e.pointerId !== g.id) return;
    const tap = !g.swiping;
    g = null;
    if (tap) {
      // Synchronously, inside the gesture: iOS opens the keyboard only then.
      term.focus();
      opts.onTap?.();
    }
  };

  const cancel = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || !g || e.pointerId !== g.id) return;
    g = null;
  };

  host.addEventListener("pointerdown", down);
  host.addEventListener("pointermove", move);
  host.addEventListener("pointerup", up);
  host.addEventListener("pointercancel", cancel);
  return () => {
    host.removeEventListener("pointerdown", down);
    host.removeEventListener("pointermove", move);
    host.removeEventListener("pointerup", up);
    host.removeEventListener("pointercancel", cancel);
  };
}

/** Phone keyboards: no autocorrect or capitals in a shell, and Enter labelled "send". */
export function setTextareaAttrs(ta: HTMLTextAreaElement): void {
  ta.setAttribute("autocapitalize", "off");
  ta.setAttribute("autocorrect", "off");
  ta.setAttribute("autocomplete", "off");
  ta.spellcheck = false;
  ta.setAttribute("enterkeyhint", "send");
}
