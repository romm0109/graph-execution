// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("App", () => {
  it("shows the login page when /api/auth/me answers 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { error: "login required" })));
    render(<App />);
    expect(await screen.findByTestId("page-login")).toBeTruthy();
  });

  it("shows the shell, redirects / to Runs, navigates, and logs out", async () => {
    const fetchMock = vi.fn(async (url: string) => (url === "/api/auth/logout" ? new Response(null, { status: 204 }) : json(200, { ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    expect(await screen.findByTestId("page-runs")).toBeTruthy();
    expect(window.location.pathname).toBe("/runs");
    for (const name of ["Workspaces", "Terminals", "Runs", "Settings"]) expect(screen.getByRole("link", { name })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(screen.getByTestId("page-settings")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByTestId("page-login")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST" }));
  });

  it("opens a deep link and returns to login on a gm:logout event", async () => {
    window.history.pushState({}, "", "/runs/github~o~r/run-1");
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { ok: true })));
    render(<App />);
    expect((await screen.findByTestId("page-run-detail")).textContent).toContain("run-1");
    act(() => {
      window.dispatchEvent(new Event("gm:logout"));
    });
    expect(screen.getByTestId("page-login")).toBeTruthy();
  });
});
