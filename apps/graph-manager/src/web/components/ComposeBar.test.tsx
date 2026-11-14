// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeBar, passthroughKey } from "./ComposeBar";
import { pasteData } from "./TerminalView";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const key = (k: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

describe("passthroughKey", () => {
  it("passes the keys a TUI needs while the box is empty", () => {
    expect(passthroughKey(key("Enter"), true)).toBe("\r");
    expect(passthroughKey(key("ArrowUp"), true)).toBe("\x1b[A");
    expect(passthroughKey(key("ArrowDown"), true)).toBe("\x1b[B");
    expect(passthroughKey(key("Tab"), true)).toBe("\t");
    expect(passthroughKey(key("Tab", { shiftKey: true }), true)).toBe("\x1b[Z");
    expect(passthroughKey(key("a"), true)).toBeUndefined();
  });

  it("keeps editing keys in the box once it has text, but Esc and Ctrl C still interrupt", () => {
    expect(passthroughKey(key("Enter"), false)).toBeUndefined();
    expect(passthroughKey(key("ArrowUp"), false)).toBeUndefined();
    expect(passthroughKey(key("Escape"), false)).toBe("\x1b");
    expect(passthroughKey(key("c", { ctrlKey: true }), false)).toBe("\x03");
    expect(passthroughKey(key("Enter", { shiftKey: true }), true)).toBeUndefined();
  });
});

describe("pasteData", () => {
  it("turns newlines into CR and wraps a bracketed paste", () => {
    expect(pasteData("a\nb\r\nc", false)).toBe("a\rb\rc");
    expect(pasteData("a\nb", true)).toBe("\x1b[200~a\rb\x1b[201~");
  });

  it("strips escape characters so the text can't end the paste early", () => {
    expect(pasteData("x\x1b[201~rm", true)).toBe("\x1b[200~x[201~rm\x1b[201~");
  });
});

describe("ComposeBar", () => {
  const setup = (disabled = false) => {
    const onSend = vi.fn();
    const onKey = vi.fn();
    render(<ComposeBar agent="claude" label="Claude Code" busy={false} disabled={disabled} onSend={onSend} onKey={onKey} />);
    const input = screen.getByTestId("compose-input") as HTMLTextAreaElement;
    return { onSend, onKey, input };
  };

  it("sends the message on Enter and clears the box; Shift Enter keeps typing", () => {
    const { onSend, onKey, input } = setup();
    fireEvent.change(input, { target: { value: "fix the bug\nand add a test" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("fix the bug\nand add a test");
    expect(input.value).toBe("");
    expect(onKey).not.toHaveBeenCalled();
  });

  it("passes Enter to the terminal when the box is empty", () => {
    const { onSend, onKey, input } = setup();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(onKey).toHaveBeenCalledWith("\r");
  });

  it("keeps the message while disconnected", () => {
    const { onSend, input } = setup(true);
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("hello");
  });

  it("the mascot jumps when clicked and gets dizzy after a burst of clicks", () => {
    vi.useFakeTimers();
    setup();
    const mascot = screen.getByTestId("mascot");
    fireEvent.click(mascot);
    act(() => void vi.advanceTimersByTime(20));
    expect(mascot.className).toContain("jump");
    for (let i = 0; i < 4; i++) fireEvent.click(mascot);
    expect(mascot.dataset.mood).toBe("dizzy");
    act(() => void vi.advanceTimersByTime(3000));
    expect(mascot.dataset.mood).toBe("idle");
  });
});
