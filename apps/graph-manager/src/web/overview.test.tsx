// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewProvider, StaleBanner, UpdatedAgo, useOverview } from "./overview";
import { ToastProvider } from "./ui/toast";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let hidden = false;
let down = false;
let runs: { workspaceId: string; id: string; status: string; live: boolean; type: string; kind: string }[] = [];

function fetchMock() {
  return vi.fn(async (url: string) => {
    if (down) throw new TypeError("fetch failed");
    if (url === "/api/runs") return json({ runs });
    if (url === "/api/terminals") return json({ terminals: [{ id: "t1", title: "claude", cwd: "/w", status: "working", createdAt: "x" }] });
    if (url === "/api/workspaces") return json({ workspaces: [{ id: "github~o~r", forge: "github", fullPath: "o/r", path: "/w/o/r", branch: "main", dirty: false, remoteUrl: "" }], root: "/w" });
    if (url === "/api/forges") return json({ github: { connected: true, login: "me" }, gitlab: { connected: false } });
    return json({ error: "nope" }, 404);
  });
}

function Probe() {
  const o = useOverview();
  return (
    <div>
      <span data-testid="runs">{o.runs.map((r) => r.id).join(",")}</span>
      <span data-testid="terms">{o.terminals.length}</span>
      <span data-testid="ws">{o.workspaces.length}</span>
      <span data-testid="root">{o.workspacesRoot}</span>
      <span data-testid="gh">{String(o.forges.github.connected)}</span>
      <span data-testid="loaded">{String(o.loaded)}</span>
      <span data-testid="failures">{o.failures}</span>
      <span data-testid="stale">{String(o.stale)}</span>
      <UpdatedAgo />
      <StaleBanner />
    </div>
  );
}

const text = (id: string) => screen.getByTestId(id).textContent;
const renderProbe = () =>
  render(
    <ToastProvider>
      <OverviewProvider>
        <Probe />
      </OverviewProvider>
    </ToastProvider>,
  );

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  down = false;
  runs = [{ workspaceId: "github~o~r", id: "20261106-1-abcd", status: "running", live: true, type: "run", kind: "run" }];
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("OverviewProvider", () => {
  it("polls the four endpoints every 2 s", async () => {
    const f = fetchMock();
    vi.stubGlobal("fetch", f);
    renderProbe();
    await act(() => vi.advanceTimersByTimeAsync(0));
    const urls = f.mock.calls.map((c) => c[0]);
    expect(urls).toEqual(expect.arrayContaining(["/api/runs", "/api/terminals", "/api/workspaces", "/api/forges"]));
    expect(text("loaded")).toBe("true");
    expect(text("runs")).toBe("20261106-1-abcd");
    expect(text("terms")).toBe("1");
    expect(text("ws")).toBe("1");
    expect(text("root")).toBe("/w");
    expect(text("gh")).toBe("true");
    expect(text("updated-ago")).toBe("updated 0s ago");
    const before = f.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(f.mock.calls.length).toBe(before + 4);
  });

  it("keeps the data when polls fail, turns stale after 3 failures and fresh again after a success", async () => {
    vi.stubGlobal("fetch", fetchMock());
    renderProbe();
    await act(() => vi.advanceTimersByTimeAsync(0));
    down = true;
    await act(() => vi.advanceTimersByTimeAsync(2000));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(text("failures")).toBe("2");
    expect(text("stale")).toBe("false");
    expect(screen.queryByTestId("stale-banner")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(text("failures")).toBe("3");
    expect(text("stale")).toBe("true");
    expect(text("runs")).toBe("20261106-1-abcd");
    expect(screen.getByTestId("updated-ago").dataset.stale).toBe("true");
    expect(text("stale-banner")).toContain("Can’t reach the server. Showing data from 6s ago. Retrying…");
    down = false;
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(text("failures")).toBe("0");
    expect(text("stale")).toBe("false");
    expect(screen.queryByTestId("stale-banner")).toBeNull();
  });

  it("doesn't poll while the document is hidden, and polls when it shows again", async () => {
    const f = fetchMock();
    vi.stubGlobal("fetch", f);
    hidden = true;
    renderProbe();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(f).not.toHaveBeenCalled();
    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(f).toHaveBeenCalledWith("/api/runs", expect.anything());
    expect(text("loaded")).toBe("true");
  });

  it("toasts when a run turns failed between two polls, not on the first load", async () => {
    runs = [
      { workspaceId: "github~o~r", id: "20261106-1-abcd", status: "running", live: true, type: "run", kind: "run" },
      { workspaceId: "github~o~r", id: "20261106-2-ffff", status: "failed", live: false, type: "run", kind: "run" },
    ];
    vi.stubGlobal("fetch", fetchMock());
    renderProbe();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.queryAllByRole("status").filter((e) => e.classList.contains("toast"))).toHaveLength(0);
    runs = [{ ...runs[0]!, status: "failed", live: false }, runs[1]!];
    await act(() => vi.advanceTimersByTimeAsync(2000));
    const toasts = screen.getByTestId("toasts");
    expect(toasts.textContent).toContain("Run abcd failed in r");
    expect(toasts.textContent).not.toContain("ffff");
  });
});
