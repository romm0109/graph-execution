// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentId } from "../types";
import { EMOTES, Mascot } from "./Mascot";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Mascot", () => {
  const cases: [AgentId | undefined, string][] = [
    ["claude", "sparkle"],
    ["codex", "whirl"],
    ["opencode", "flip"],
    ["qwen", "boing"],
    [undefined, "type"],
  ];

  it.each(cases)("%s does its own emote when clicked (%s)", (agent, emote) => {
    vi.useFakeTimers();
    render(<Mascot agent={agent} label="x" busy={false} fed={0} />);
    const mascot = screen.getByTestId("mascot");
    fireEvent.click(mascot);
    act(() => void vi.advanceTimersByTime(20));
    expect(mascot.dataset.emote).toBe(emote);
    expect(mascot.className).toContain(`emote-${emote}`);
    act(() => void vi.advanceTimersByTime(EMOTES[agent ?? "terminal"].ms + 20));
    expect(mascot.dataset.emote).toBeUndefined();
  });

  it("gets dizzy after a burst of clicks and ignores clicks until it recovers", () => {
    vi.useFakeTimers();
    render(<Mascot agent="claude" label="Claude Code" busy={false} fed={0} />);
    const mascot = screen.getByTestId("mascot");
    for (let i = 0; i < 5; i++) fireEvent.click(mascot);
    expect(mascot.dataset.mood).toBe("dizzy");
    fireEvent.click(mascot);
    act(() => void vi.advanceTimersByTime(20));
    expect(mascot.dataset.mood).toBe("dizzy");
    act(() => void vi.advanceTimersByTime(3000));
    expect(mascot.dataset.mood).toBe("idle");
  });

  it("shows the working mood while the process prints", () => {
    render(<Mascot agent="codex" label="Codex" busy fed={0} />);
    expect(screen.getByTestId("mascot").dataset.mood).toBe("busy");
    expect(screen.getByLabelText("Codex (working)")).toBeTruthy();
  });
});
