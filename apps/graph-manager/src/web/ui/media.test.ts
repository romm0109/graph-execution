// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COARSE, NARROW, PHONE, useMedia } from "./media";

/** A fake MediaQueryList whose `matches` can be flipped with `set()`; fires `change` like a browser. */
function stubMedia(initial: Record<string, boolean>) {
  const state = { ...initial };
  const listeners = new Map<string, Set<() => void>>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({
      get matches() {
        return state[q] ?? false;
      },
      media: q,
      addEventListener: (_: string, fn: () => void) => {
        let set = listeners.get(q);
        if (!set) listeners.set(q, (set = new Set()));
        set.add(fn);
      },
      removeEventListener: (_: string, fn: () => void) => {
        listeners.get(q)?.delete(fn);
      },
    })),
  );
  return {
    set(q: string, v: boolean) {
      state[q] = v;
      listeners.get(q)?.forEach((fn) => fn());
    },
    listeners,
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("media queries", () => {
  it("has the app's breakpoints", () => {
    expect(NARROW).toBe("(max-width: 899.98px)");
    expect(PHONE).toBe("(max-width: 599.98px)");
    expect(COARSE).toBe("(pointer: coarse)");
  });
});

describe("useMedia", () => {
  it("is false without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => useMedia(NARROW));
    expect(result.current).toBe(false);
  });

  it("follows the initial match", () => {
    stubMedia({ [NARROW]: true });
    expect(renderHook(() => useMedia(NARROW)).result.current).toBe(true);
    expect(renderHook(() => useMedia(PHONE)).result.current).toBe(false);
  });

  it("follows change events and unsubscribes on unmount", () => {
    const m = stubMedia({ [NARROW]: false });
    const { result, unmount } = renderHook(() => useMedia(NARROW));
    expect(result.current).toBe(false);
    act(() => m.set(NARROW, true));
    expect(result.current).toBe(true);
    act(() => m.set(NARROW, false));
    expect(result.current).toBe(false);
    unmount();
    expect(m.listeners.get(NARROW)?.size ?? 0).toBe(0);
  });
});
