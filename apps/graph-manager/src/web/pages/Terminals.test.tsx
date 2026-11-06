// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import Terminals, { type TerminalInfo } from "./Terminals";

vi.mock("../components/TerminalView", () => ({
  default: ({ id, active }: { id: string; active: boolean }) => <div data-testid={`terminal-view-${id}`} data-active={String(active)} />,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const term = (id: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({ id, title: id, cwd: "/ws", status: "idle", createdAt: "2026-01-01T00:00:00Z", ...extra });

function serve(initial: TerminalInfo[]) {
  const terminals = [...initial];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/terminals" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { workspaceId?: string };
      const t = term(`t${terminals.length + 1}`, body.workspaceId ? { workspaceId: body.workspaceId, title: "o/r" } : {});
      terminals.push(t);
      return json(201, t);
    }
    if (url === "/api/terminals") return json(200, { terminals });
    return json(404, { error: "not found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Terminals page", () => {
  it("lists terminals with their status and switches tabs", async () => {
    serve([term("t1", { status: "working" }), term("t2", { status: "exited", exitCode: 0, workspaceId: "github~o~r" })]);
    render(
      <MemoryRouter initialEntries={["/terminals"]}>
        <Terminals />
      </MemoryRouter>,
    );
    const item1 = await screen.findByTestId("terminal-item-t1");
    expect(item1.textContent).toContain("working");
    expect(screen.getByTestId("terminal-item-t2").textContent).toContain("exited 0");
    expect(screen.getByTestId("terminal-item-t2").textContent).toContain("github~o~r");
    expect(screen.getByTestId("terminal-view-t2").dataset.active).toBe("true");
    fireEvent.click(item1);
    expect(screen.getByTestId("terminal-view-t1").dataset.active).toBe("true");
    expect(screen.getByTestId("terminal-view-t2").dataset.active).toBe("false");
  });

  it("opens a terminal in ?workspace= on load and with New terminal", async () => {
    const fetchMock = serve([]);
    render(
      <MemoryRouter initialEntries={["/terminals?workspace=github~o~r"]}>
        <Terminals />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("terminal-view-t1")).toBeTruthy();
    const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0]?.[1]?.body))).toEqual({ workspaceId: "github~o~r" });
    fireEvent.click(screen.getByTestId("new-terminal"));
    await waitFor(() => expect(screen.getByTestId("terminal-view-t2").dataset.active).toBe("true"));
    expect(posts()).toHaveLength(2);
  });
});
