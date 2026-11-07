// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, getThemePref, resolveTheme, setThemePref, THEME_KEY } from "./theme";

function stubMatchMedia(dark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: dark && query === "(prefers-color-scheme: dark)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("theme", () => {
  it("setThemePref('dark') sets data-theme and saves it", () => {
    stubMatchMedia(false);
    setThemePref("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(getThemePref()).toBe("dark");
    setThemePref("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("light");
  });

  it("'system' follows prefers-color-scheme", () => {
    stubMatchMedia(true);
    setThemePref("system");
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    expect(getThemePref()).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
    stubMatchMedia(false);
    expect(applyTheme()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("ignores an invalid saved value", () => {
    stubMatchMedia(false);
    window.localStorage.setItem(THEME_KEY, "purple");
    expect(getThemePref()).toBe("system");
    expect(resolveTheme()).toBe("light");
  });

  it("does not crash when localStorage throws", () => {
    stubMatchMedia(false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getThemePref()).toBe("system");
    expect(() => setThemePref("dark")).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(() => applyTheme()).not.toThrow();
  });
});
