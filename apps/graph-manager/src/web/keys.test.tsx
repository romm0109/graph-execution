// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTypingTarget, matchesCombo, useKey, useListNav } from "./keys";

afterEach(cleanup);

function List({ onOpen }: { onOpen: (i: number) => void }) {
  const [index] = useListNav(3, { onOpen });
  return (
    <div>
      <input data-testid="input" />
      <span data-testid="index">{index}</span>
    </div>
  );
}

describe("useListNav", () => {
  it("moves with j/k and opens with Enter", () => {
    const onOpen = vi.fn();
    render(<List onOpen={onOpen} />);
    const idx = () => screen.getByTestId("index").textContent;
    expect(idx()).toBe("-1");
    fireEvent.keyDown(document.body, { key: "j" });
    fireEvent.keyDown(document.body, { key: "j" });
    expect(idx()).toBe("1");
    fireEvent.keyDown(document.body, { key: "j" });
    fireEvent.keyDown(document.body, { key: "j" });
    expect(idx()).toBe("2");
    fireEvent.keyDown(document.body, { key: "k" });
    expect(idx()).toBe("1");
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it("ignores keys typed in an input", () => {
    const onOpen = vi.fn();
    render(<List onOpen={onOpen} />);
    const input = screen.getByTestId("input");
    fireEvent.keyDown(input, { key: "j" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("index").textContent).toBe("-1");
    expect(onOpen).not.toHaveBeenCalled();
  });
});

function KeyProbe({ fn, allowInInput }: { fn: () => void; allowInInput?: boolean }) {
  useKey("Ctrl+k", fn, { allowInInput });
  return (
    <div>
      <input data-testid="input" />
      <div className="xterm">
        <textarea data-testid="term" />
      </div>
    </div>
  );
}

describe("useKey", () => {
  it("fires on its combo, in inputs only when allowed, never in a terminal", () => {
    const fn = vi.fn();
    const { rerender } = render(<KeyProbe fn={fn} />);
    fireEvent.keyDown(document.body, { key: "k" });
    expect(fn).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(fn).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByTestId("input"), { key: "k", ctrlKey: true });
    expect(fn).toHaveBeenCalledTimes(1);
    rerender(<KeyProbe fn={fn} allowInInput />);
    fireEvent.keyDown(screen.getByTestId("input"), { key: "k", ctrlKey: true });
    expect(fn).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByTestId("term"), { key: "k", ctrlKey: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("matches combos and typing targets", () => {
    expect(matchesCombo(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }), "Ctrl+Enter")).toBe(true);
    expect(matchesCombo(new KeyboardEvent("keydown", { key: "/" }), "/")).toBe(true);
    expect(matchesCombo(new KeyboardEvent("keydown", { key: "s", ctrlKey: true }), "s")).toBe(false);
    expect(matchesCombo(new KeyboardEvent("keydown", { key: "Escape" }), "Escape")).toBe(true);
    const ta = document.createElement("textarea");
    const div = document.createElement("div");
    expect(isTypingTarget(ta)).toBe(true);
    expect(isTypingTarget(div)).toBe(false);
  });
});
