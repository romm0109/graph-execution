// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installState, isDesktopApp, isIos, isStandalone, registerSw, standaloneLinkHandler, useStandaloneLinks } from "./standalone";

function stubStandalone(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: matches && q === "(display-mode: standalone)", addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  delete (navigator as { standalone?: boolean }).standalone;
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  delete (window as { isSecureContext?: boolean }).isSecureContext;
});

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

describe("isStandalone", () => {
  it("is true when display-mode is standalone", () => {
    stubStandalone(true);
    expect(isStandalone()).toBe(true);
  });

  it("is false in a browser tab", () => {
    stubStandalone(false);
    expect(isStandalone()).toBe(false);
  });

  it("is true with iOS navigator.standalone", () => {
    stubStandalone(false);
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    expect(isStandalone()).toBe(true);
  });

  it("is false without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(isStandalone()).toBe(false);
  });
});

describe("isIos", () => {
  it("knows iPhones, iPads posing as Macs, and not Macs or Android", () => {
    expect(isIos({ userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
    expect(isIos({ userAgent: ANDROID, platform: "Linux armv8l", maxTouchPoints: 5 })).toBe(false);
  });

  it("reads navigator by default", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE);
    expect(isIos()).toBe(true);
  });
});

describe("standalone links", () => {
  function link(href: string, target?: string) {
    const a = document.createElement("a");
    a.href = href;
    if (target) a.target = target;
    a.textContent = "open";
    document.body.appendChild(a);
    return a;
  }
  const click = () => new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  /** Dispatches through standaloneLinkHandler; returns whether it prevented the click (jsdom never follows the link). */
  function viaHandler(a: HTMLAnchorElement, ev: MouseEvent): boolean {
    let prevented = false;
    const stop = (e: Event) => {
      prevented = e.defaultPrevented;
      e.preventDefault();
    };
    a.addEventListener("click", standaloneLinkHandler);
    document.addEventListener("click", stop);
    a.dispatchEvent(ev);
    document.removeEventListener("click", stop);
    return prevented;
  }

  function spyAssign() {
    const assign = vi.fn();
    vi.stubGlobal("location", { href: window.location.href, origin: window.location.origin, assign });
    return assign;
  }

  it("opens a same-origin _blank link in the same window", () => {
    const a = link("/runs/ws/r/view/", "_blank");
    const assign = spyAssign();
    expect(viaHandler(a, click())).toBe(true);
    expect(assign).toHaveBeenCalledWith("http://localhost:3000/runs/ws/r/view/");
  });

  it("leaves other-origin links alone", () => {
    const a = link("https://github.com/o/r/pull/1", "_blank");
    const assign = spyAssign();
    expect(viaHandler(a, click())).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("leaves links without a target alone", () => {
    const a = link("/runs/ws/r/view/");
    const assign = spyAssign();
    expect(viaHandler(a, click())).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("leaves modified clicks alone", () => {
    const a = link("/runs/ws/r/view/", "_blank");
    const assign = spyAssign();
    expect(viaHandler(a, new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true }))).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("useStandaloneLinks listens only in standalone mode", () => {
    const a = link("/runs/ws/r/view/", "_blank");
    const assign = spyAssign();
    // Records whether the capture listener prevented the click, then stops jsdom from following the link.
    const seen: boolean[] = [];
    const record = (e: Event) => {
      seen.push(e.defaultPrevented);
      e.preventDefault();
    };
    document.addEventListener("click", record);
    stubStandalone(false);
    const off = renderHook(() => useStandaloneLinks());
    a.dispatchEvent(click());
    off.unmount();

    stubStandalone(true);
    const on = renderHook(() => useStandaloneLinks());
    a.dispatchEvent(click());
    on.unmount();

    a.dispatchEvent(click());
    document.removeEventListener("click", record);
    expect(seen).toEqual([false, true, false]);
    expect(assign).toHaveBeenCalledTimes(1);
  });
});

describe("registerSw", () => {
  function setup({ secure, sw }: { secure: boolean; sw: boolean }) {
    Object.defineProperty(window, "isSecureContext", { value: secure, configurable: true });
    const register = vi.fn(async () => ({}));
    if (sw) Object.defineProperty(navigator, "serviceWorker", { value: { register }, configurable: true });
    return register;
  }

  it("registers /sw.js in production on a secure context", () => {
    const register = setup({ secure: true, sw: true });
    expect(registerSw(true)).toBe(true);
    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("does nothing outside a production build", () => {
    const register = setup({ secure: true, sw: true });
    expect(registerSw(false)).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it("does nothing on plain HTTP", () => {
    const register = setup({ secure: false, sw: true });
    expect(registerSw(true)).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it("does nothing without service workers", () => {
    setup({ secure: true, sw: false });
    expect("serviceWorker" in navigator).toBe(false);
    expect(registerSw(true)).toBe(false);
  });
});

describe("installState", () => {
  const base = { standalone: false, secure: true, hasPrompt: false, ios: false };
  it.each([
    [{ ...base, standalone: true, secure: false, hasPrompt: true, ios: true }, "installed"],
    [{ ...base, secure: false, hasPrompt: true, ios: true }, "insecure"],
    [{ ...base, hasPrompt: true, ios: true }, "prompt"],
    [{ ...base, ios: true }, "ios"],
    [base, "other"],
  ] as const)("%o → %s", (input, expected) => {
    expect(installState(input)).toBe(expected);
  });
});

describe("isDesktopApp", () => {
  it("is true only with the desktop app's user-agent token", () => {
    const electron = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Electron/45.3.2 Safari/537.36";
    expect(isDesktopApp(`${electron} graph-manager-desktop/0.1.0`)).toBe(true);
    expect(isDesktopApp(electron)).toBe(false);
    expect(isDesktopApp("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")).toBe(false);
    expect(isDesktopApp("Mozilla/5.0 my-graph-manager-desktop-clone")).toBe(false);
  });
});
