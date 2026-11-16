// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isEditable, isKeyboardOpen, isZoomed, useVisualViewport } from "./viewport";

class FakeVV extends EventTarget {
  height = 800;
  width = 390;
  offsetTop = 0;
  scale = 1;
}

const root = () => document.documentElement;
const appH = () => root().style.getPropertyValue("--app-h");
const kbOpen = () => root().classList.contains("kb-open");

beforeEach(() => {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  vi.stubGlobal("scrollTo", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  root().classList.remove("kb-open");
  root().style.removeProperty("--app-h");
});

describe("isKeyboardOpen", () => {
  it("needs a much shorter viewport and an editable focus", () => {
    expect(isKeyboardOpen(500, 800, true)).toBe(true);
    expect(isKeyboardOpen(700, 800, true)).toBe(false);
    expect(isKeyboardOpen(680, 800, true)).toBe(false);
    expect(isKeyboardOpen(500, 800, false)).toBe(false);
  });
});

describe("isZoomed", () => {
  it("is true only above a scale of about 1", () => {
    expect(isZoomed(2)).toBe(true);
    expect(isZoomed(1)).toBe(false);
    expect(isZoomed(1.005)).toBe(false);
    expect(isZoomed(undefined)).toBe(false);
  });
});

describe("isEditable", () => {
  const el = (html: string) => {
    const d = document.createElement("div");
    d.innerHTML = html;
    return d.firstElementChild;
  };
  it("accepts text fields", () => {
    expect(isEditable(el("<textarea></textarea>"))).toBe(true);
    expect(isEditable(el('<input type="text">'))).toBe(true);
    expect(isEditable(el("<input>"))).toBe(true);
    expect(isEditable(el('<div contenteditable="true"></div>'))).toBe(true);
  });
  it("rejects other elements", () => {
    expect(isEditable(el('<input type="checkbox">'))).toBe(false);
    expect(isEditable(el("<button></button>"))).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});

describe("useVisualViewport", () => {
  it("tracks the visual viewport height, the keyboard and the iOS pan", () => {
    const vv = new FakeVV();
    vi.stubGlobal("visualViewport", vv);
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    const { unmount } = renderHook(() => useVisualViewport());
    expect(appH()).toBe("800px");

    const ta = document.createElement("textarea");
    document.body.append(ta);
    ta.focus();
    act(() => {
      vv.height = 420;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(appH()).toBe("420px");
    expect(kbOpen()).toBe(true);

    act(() => {
      vv.offsetTop = 60;
      vv.dispatchEvent(new Event("scroll"));
    });
    expect(scrollTo).toHaveBeenCalledWith(0, 0);

    ta.blur();
    act(() => {
      vv.height = 800;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(kbOpen()).toBe(false);

    unmount();
    expect(appH()).toBe("");
    expect(kbOpen()).toBe(false);
  });

  it("does not set kb-open while a non-editable element has focus", () => {
    const vv = new FakeVV();
    vi.stubGlobal("visualViewport", vv);
    renderHook(() => useVisualViewport());
    const b = document.createElement("button");
    document.body.append(b);
    b.focus();
    act(() => {
      vv.height = 420;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(appH()).toBe("420px");
    expect(kbOpen()).toBe(false);
  });

  it("ignores a pinch zoom: --app-h, kb-open and the scroll stay as they were", () => {
    const vv = new FakeVV();
    vi.stubGlobal("visualViewport", vv);
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    renderHook(() => useVisualViewport());
    const ta = document.createElement("textarea");
    document.body.append(ta);
    ta.focus();
    act(() => {
      vv.scale = 2;
      vv.height = 400;
      vv.offsetTop = 120;
      vv.dispatchEvent(new Event("resize"));
      vv.dispatchEvent(new Event("scroll"));
    });
    expect(appH()).toBe("800px");
    expect(kbOpen()).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();

    act(() => {
      vv.scale = 1;
      vv.height = 800;
      vv.offsetTop = 0;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(appH()).toBe("800px");
  });

  it("sees the Android keyboard when innerHeight shrinks with the visual viewport", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} }));
    const vv = new FakeVV();
    vi.stubGlobal("visualViewport", vv);
    renderHook(() => useVisualViewport());
    const ta = document.createElement("textarea");
    document.body.append(ta);
    ta.focus();
    act(() => {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 420 });
      vv.height = 420;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(appH()).toBe("420px");
    expect(kbOpen()).toBe(true);

    ta.blur();
    act(() => {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
      vv.height = 800;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(kbOpen()).toBe(false);
  });

  it("starts a new baseline after a rotation (width change)", () => {
    const vv = new FakeVV();
    vi.stubGlobal("visualViewport", vv);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    renderHook(() => useVisualViewport());
    const ta = document.createElement("textarea");
    document.body.append(ta);
    ta.focus();
    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 844 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 390 });
      vv.height = 390;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(kbOpen()).toBe(false);
  });

  it("falls back to window.innerHeight without a visual viewport", () => {
    vi.stubGlobal("visualViewport", undefined);
    renderHook(() => useVisualViewport());
    expect(appH()).toBe("800px");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 640 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(appH()).toBe("640px");
  });
});
