// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { loadPlugins, resetPlugins, type Importer } from "./plugins";

afterEach(() => {
  cleanup();
  resetPlugins();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A signed-in server whose `/api/ui/plugins` answers `plugins` (a Response for errors); every other URL a harmless body. */
function stubServer(plugins: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/me") return json(200, { user: { id: "admin", name: "admin" }, mode: "users" });
      if (url === "/api/account") return json(200, { id: "admin", displayName: "admin" });
      if (url === "/api/ui/plugins") return plugins instanceof Response ? plugins : json(200, plugins);
      return json(200, { ok: true });
    }),
  );
}

const hello = (): Promise<{ default?: unknown }> => import("./test-fixtures/hello-plugin.js");
const importer =
  (modules: Record<string, () => Promise<{ default?: unknown }>>): Importer =>
  (url) =>
    modules[url]?.() ?? Promise.reject(new Error(`unknown ${url}`));

const navLabels = () =>
  screen
    .getAllByRole("link")
    .filter((a) => a.classList.contains("nav-item"))
    .map((a) => a.getAttribute("aria-label"));

const BUILTIN_NAV = ["Runs", "Terminals", "Projects", "Reviewers", "Settings"];

describe("UI plugins", () => {
  it("add a nav item, a page, a top-bar item and a Settings section; hooks work through api.React", async () => {
    stubServer({ plugins: ["/plugins/hello.js"] });
    void loadPlugins(importer({ "/plugins/hello.js": hello }));
    render(<App />);
    expect(await screen.findByTestId("page-runs")).toBeTruthy();
    await screen.findByRole("link", { name: "Billing" });
    expect(navLabels()).toEqual([...BUILTIN_NAV, "Billing"]);
    expect(within(screen.getByTestId("nav-plugin-slot")).getByTestId("plan-badge").textContent).toBe("Pro plan");

    fireEvent.click(screen.getByRole("link", { name: "Billing" }));
    const page = await screen.findByTestId("page-billing");
    const button = within(page).getByRole("button");
    expect(button.textContent).toBe("Clicked 0");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button.textContent).toBe("Clicked 2");

    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    const section = await screen.findByTestId("plugin-settings-section");
    expect(within(section).getByRole("heading").textContent).toBe("Plan");
    expect(section.textContent).toContain("You are on the Pro plan.");
  });

  it("serve a deep link to a plugin page instead of redirecting to /runs", async () => {
    window.history.pushState({}, "", "/billing");
    stubServer({ plugins: ["/plugins/hello.js"] });
    void loadPlugins(importer({ "/plugins/hello.js": hello }));
    render(<App />);
    expect(await screen.findByTestId("page-billing")).toBeTruthy();
    expect(window.location.pathname).toBe("/billing");
  });

  it("skip a plugin that fails to import and still load the others", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stubServer({ plugins: ["/bad.js", "/plugins/hello.js"] });
    void loadPlugins(importer({ "/plugins/hello.js": hello }));
    render(<App />);
    expect(await screen.findByRole("link", { name: "Billing" })).toBeTruthy();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("/bad.js");
  });

  it("skip a module whose default export is not a function, and one that throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stubServer({ plugins: ["/obj.js", "/throws.js", "/plugins/hello.js"] });
    void loadPlugins(
      importer({
        "/obj.js": async () => ({ default: { nope: true } }),
        "/throws.js": async () => ({
          default: () => {
            throw new Error("boom");
          },
        }),
        "/plugins/hello.js": hello,
      }),
    );
    render(<App />);
    expect(await screen.findByRole("link", { name: "Billing" })).toBeTruthy();
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0]?.[0])).toBe("graph-manager: plugin /obj.js has no default export function");
    expect(String(error.mock.calls[1]?.[0])).toContain("/throws.js");
  });

  it.each([
    ["none are configured", { plugins: [] }],
    ["/api/ui/plugins fails", json(500, { error: "boom" })],
  ])("leave the UI unchanged when %s", async (_name, answer) => {
    stubServer(answer);
    render(<App />);
    expect(await screen.findByTestId("page-runs")).toBeTruthy();
    await act(() => loadPlugins());
    expect(navLabels()).toEqual(BUILTIN_NAV);
    expect(screen.queryByTestId("nav-plugin-slot")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(screen.getByTestId("page-settings")).toBeTruthy();
    expect(screen.queryByTestId("plugin-settings-section")).toBeNull();
  });

  it("cannot replace a built-in page", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    window.history.pushState({}, "", "/settings");
    stubServer({ plugins: ["/takeover.js"] });
    void loadPlugins(
      importer({
        "/takeover.js": async () => ({
          default: (api: { React: typeof import("react"); registerRoute: (r: { path: string; element: unknown }) => void }) =>
            api.registerRoute({ path: "/settings", element: api.React.createElement("p", { "data-testid": "takeover" }) }),
        }),
      }),
    );
    render(<App />);
    expect(await screen.findByTestId("page-settings")).toBeTruthy();
    await act(() => loadPlugins());
    expect(screen.queryByTestId("takeover")).toBeNull();
    expect(error).toHaveBeenCalledWith("graph-manager: plugin /takeover.js cannot replace the page /settings");
  });
});
