import { describe, expect, it } from "vitest";
import { classifyLink, desktopUserAgent } from "./links.js";

const app = "http://127.0.0.1:5";

describe("classifyLink", () => {
  it("opens same-origin pages in a new app window", () => {
    expect(classifyLink("http://127.0.0.1:5/runs/a/b/view/", app, "open")).toBe("new-window");
  });
  it("keeps same-origin navigation in the window", () => {
    expect(classifyLink("http://127.0.0.1:5/settings", app, "navigate")).toBe("same-window");
  });
  it("sends other web and mail links to the system browser", () => {
    expect(classifyLink("https://github.com/o/r/pull/1", app, "open")).toBe("external");
    expect(classifyLink("https://github.com/o/r/pull/1", app, "navigate")).toBe("external");
    expect(classifyLink("http://127.0.0.1:6/", app, "open")).toBe("external");
    expect(classifyLink("mailto:a@example.com", app, "open")).toBe("external");
  });
  it("denies other schemes and bad URLs", () => {
    expect(classifyLink("file:///etc/passwd", app, "open")).toBe("deny");
    expect(classifyLink("javascript:alert(1)", app, "navigate")).toBe("deny");
    expect(classifyLink("data:text/html,hi", app, "open")).toBe("deny");
    expect(classifyLink("chrome://settings", app, "navigate")).toBe("deny");
    expect(classifyLink("devtools://devtools", app, "open")).toBe("deny");
    expect(classifyLink("not a url", app, "open")).toBe("deny");
  });
  it("allows about:blank only as a navigation", () => {
    expect(classifyLink("about:blank", app, "navigate")).toBe("same-window");
    expect(classifyLink("about:blank", app, "open")).toBe("deny");
  });
});

describe("the Switch server request", () => {
  it("is recognized for open and navigate; other gm-desktop: URLs are denied", () => {
    expect(classifyLink("gm-desktop:switch-server", app, "open")).toBe("switch-server");
    expect(classifyLink("gm-desktop:switch-server", app, "navigate")).toBe("switch-server");
    expect(classifyLink("gm-desktop:other", app, "open")).toBe("deny");
    expect(classifyLink("gm-desktop://switch-server", app, "open")).toBe("deny");
  });
  it("adds the desktop token to the user agent", () => {
    expect(desktopUserAgent("Mozilla/5.0 Electron/45.3.2", "0.1.0")).toBe("Mozilla/5.0 Electron/45.3.2 graph-manager-desktop/0.1.0");
  });
});
