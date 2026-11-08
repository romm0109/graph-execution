// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
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
  it("sees rows committed before React ran their passive effects (Workspaces j/j/Enter race)", async () => {
    // findByTestId resolves from a MutationObserver: a microtask right after React commits the new rows, before the
    // scheduler runs that render's passive effects. Keys pressed then must already count the new rows.
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const before = g.IS_REACT_ACT_ENVIRONMENT;
    g.IS_REACT_ACT_ENVIRONMENT = false;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const onOpen = vi.fn();
    function Rows({ count }: { count: number }) {
      useListNav(count, { onOpen });
      return <span>{count}</span>;
    }
    try {
      flushSync(() => root.render(<Rows count={0} />));
      await new Promise<void>((resolve) => {
        const obs = new MutationObserver(() => {
          if (host.textContent !== "2") return;
          obs.disconnect();
          fireEvent.keyDown(window, { key: "j" });
          fireEvent.keyDown(window, { key: "j" });
          fireEvent.keyDown(window, { key: "Enter" });
          resolve();
        });
        obs.observe(host, { subtree: true, childList: true, characterData: true });
        root.render(<Rows count={2} />); // a default-priority update, as when a fetch resolves
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(onOpen).toHaveBeenCalledWith(1);
    } finally {
      flushSync(() => root.unmount());
      host.remove();
      g.IS_REACT_ACT_ENVIRONMENT = before;
    }
  });

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
