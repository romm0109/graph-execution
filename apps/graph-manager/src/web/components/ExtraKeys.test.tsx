// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtraKeys, keySequence, type SeqKey } from "./ExtraKeys";

afterEach(cleanup);

const makeHandle = (app = false) => ({ input: vi.fn(), focus: vi.fn(), appCursor: vi.fn(() => app) });

describe("keySequence", () => {
  it.each<[SeqKey, string, string]>([
    ["esc", "\x1b", "\x1b"],
    ["tab", "\t", "\t"],
    ["up", "\x1b[A", "\x1bOA"],
    ["down", "\x1b[B", "\x1bOB"],
    ["left", "\x1b[D", "\x1bOD"],
    ["right", "\x1b[C", "\x1bOC"],
  ])("%s", (key, normal, app) => {
    expect(keySequence(key, false)).toBe(normal);
    expect(keySequence(key, true)).toBe(app);
  });
});

describe("ExtraKeys", () => {
  it("is a labelled toolbar", () => {
    render(<ExtraKeys handle={makeHandle()} ctrl={false} onCtrl={() => {}} onPrefix={() => {}} />);
    const bar = screen.getByTestId("extra-keys");
    expect(bar.getAttribute("role")).toBe("toolbar");
    expect(bar.getAttribute("aria-label")).toBe("Terminal keys");
  });

  it("sends each key's sequence", () => {
    const handle = makeHandle();
    render(<ExtraKeys handle={handle} ctrl={false} onCtrl={() => {}} onPrefix={() => {}} />);
    const cases: [string, string][] = [
      ["xk-esc", "\x1b"],
      ["xk-tab", "\t"],
      ["xk-up", "\x1b[A"],
      ["xk-down", "\x1b[B"],
      ["xk-left", "\x1b[D"],
      ["xk-right", "\x1b[C"],
    ];
    for (const [id, seq] of cases) {
      handle.input.mockClear();
      fireEvent.click(screen.getByTestId(id));
      expect(handle.input).toHaveBeenCalledWith(seq);
    }
  });

  it("arrows follow the application cursor mode at click time", () => {
    const handle = makeHandle(true);
    render(<ExtraKeys handle={handle} ctrl={false} onCtrl={() => {}} onPrefix={() => {}} />);
    fireEvent.click(screen.getByTestId("xk-up"));
    expect(handle.input).toHaveBeenCalledWith("\x1bOA");
  });

  it("no key takes focus on pointerdown or mousedown", () => {
    render(<ExtraKeys handle={makeHandle()} ctrl={false} onCtrl={() => {}} onPrefix={() => {}} />);
    for (const id of ["esc", "tab", "ctrl", "up", "down", "left", "right", "prefix"]) {
      const el = screen.getByTestId(`xk-${id}`);
      expect(fireEvent.pointerDown(el)).toBe(false);
      expect(fireEvent.mouseDown(el)).toBe(false);
    }
  });

  it("Ctrl toggles and shows its state", () => {
    const onCtrl = vi.fn();
    const { rerender } = render(<ExtraKeys handle={makeHandle()} ctrl={false} onCtrl={onCtrl} onPrefix={() => {}} />);
    const btn = () => screen.getByTestId("xk-ctrl");
    expect(btn().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn());
    expect(onCtrl).toHaveBeenLastCalledWith(true);
    rerender(<ExtraKeys handle={makeHandle()} ctrl={true} onCtrl={onCtrl} onPrefix={() => {}} />);
    expect(btn().getAttribute("aria-pressed")).toBe("true");
    expect(btn().className).toContain("on");
    fireEvent.click(btn());
    expect(onCtrl).toHaveBeenLastCalledWith(false);
  });

  it("the prefix key arms the prefix and types nothing", () => {
    const handle = makeHandle();
    const onPrefix = vi.fn();
    render(<ExtraKeys handle={handle} ctrl={false} onCtrl={() => {}} onPrefix={onPrefix} />);
    const btn = screen.getByTestId("xk-prefix");
    expect(btn.textContent).toBe("⌃␣");
    expect(btn.getAttribute("aria-label")).toBe("Ctrl Space");
    fireEvent.click(btn);
    expect(onPrefix).toHaveBeenCalledTimes(1);
    expect(handle.input).not.toHaveBeenCalled();
  });
});
