// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachTouch, setTextareaAttrs } from "./touch";

let host: HTMLDivElement;
let element: HTMLDivElement;
let term: { focus: ReturnType<typeof vi.fn>; element: HTMLElement; rows: number; scrollLines: ReturnType<typeof vi.fn> };
let onTap: ReturnType<typeof vi.fn>;
let dispose: () => void;

const p = (type: string, x: number, y: number, pointerType = "touch", pointerId = 1) =>
  element.dispatchEvent(new PointerEvent(type, { pointerType, pointerId, clientX: x, clientY: y, bubbles: true, cancelable: true }));

function swipeUp30(pointerType = "touch") {
  p("pointerdown", 100, 200, pointerType);
  p("pointermove", 100, 190, pointerType);
  p("pointermove", 100, 180, pointerType);
  p("pointermove", 100, 170, pointerType);
  p("pointerup", 100, 170, pointerType);
}

beforeEach(() => {
  host = document.createElement("div");
  element = document.createElement("div");
  host.appendChild(element);
  document.body.appendChild(host);
  term = { focus: vi.fn(), element, rows: 24, scrollLines: vi.fn() };
  onTap = vi.fn();
  dispose = attachTouch(host, term, { onTap });
});

afterEach(() => {
  dispose();
  host.remove();
});

describe("attachTouch", () => {
  it("a short touch focuses the terminal and calls onTap", () => {
    const wheel = vi.fn();
    element.addEventListener("wheel", wheel);
    p("pointerdown", 100, 100);
    p("pointermove", 104, 103);
    p("pointerup", 104, 103);
    expect(term.focus).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(wheel).not.toHaveBeenCalled();
  });

  it("a 30 px swipe dispatches wheel events and never focuses", () => {
    const wheel = vi.fn();
    element.addEventListener("wheel", wheel);
    swipeUp30();
    expect(wheel).toHaveBeenCalled();
    const ev = wheel.mock.calls[0]![0] as WheelEvent;
    expect(ev.deltaY).toBeGreaterThan(0);
    expect(ev.deltaMode).toBe(0);
    expect(term.focus).not.toHaveBeenCalled();
    expect(onTap).not.toHaveBeenCalled();
  });

  it("a wheel event nobody handles scrolls the scrollback", () => {
    Object.defineProperty(element, "clientHeight", { value: 240 });
    swipeUp30();
    const lines = term.scrollLines.mock.calls.map((c) => c[0] as number);
    expect(lines.length).toBeGreaterThan(0);
    for (const n of lines) expect(n).toBeGreaterThan(0);
    expect(lines.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("a wheel event xterm handles (preventDefault) is not scrolled again", () => {
    element.addEventListener("wheel", (e) => e.preventDefault());
    swipeUp30();
    expect(term.scrollLines).not.toHaveBeenCalled();
  });

  it("a mouse pointer is ignored", () => {
    const wheel = vi.fn();
    element.addEventListener("wheel", wheel);
    p("pointerdown", 100, 100, "mouse");
    p("pointerup", 104, 103, "mouse");
    expect(term.focus).not.toHaveBeenCalled();
    swipeUp30("mouse");
    expect(wheel).not.toHaveBeenCalled();
  });

  it("a second finger cancels the gesture", () => {
    p("pointerdown", 100, 100);
    p("pointerdown", 150, 100, "touch", 2);
    p("pointerup", 100, 100);
    expect(term.focus).not.toHaveBeenCalled();
  });

  it("dispose removes the listeners", () => {
    dispose();
    p("pointerdown", 100, 100);
    p("pointerup", 100, 100);
    expect(term.focus).not.toHaveBeenCalled();
  });
});

describe("setTextareaAttrs", () => {
  it("turns off phone keyboard helpers", () => {
    const ta = document.createElement("textarea");
    setTextareaAttrs(ta);
    expect(ta.getAttribute("autocapitalize")).toBe("off");
    expect(ta.getAttribute("autocorrect")).toBe("off");
    expect(ta.getAttribute("autocomplete")).toBe("off");
    expect(ta.getAttribute("enterkeyhint")).toBe("send");
    expect(ta.spellcheck).toBe(false);
  });
});
