// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEntry } from "../types";
import { ToastProvider } from "../ui/toast";
import { PROVIDER_KEY, StartRunDrawer, commandPreview } from "./StartRunDrawer";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const WS = "github~octo~hello";
const WORKSPACES: WorkspaceEntry[] = [
  { id: WS, forge: "github", fullPath: "octo/hello", path: "/ws/github/octo/hello", branch: "main", dirty: true, remoteUrl: "" },
  { id: "github~acme~web", forge: "github", fullPath: "acme/web", path: "/ws/github/acme/web", branch: "main", dirty: false, remoteUrl: "" },
];

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function stub(post?: Handler) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith(`/api/workspaces/${WS}/inspect`)) {
      const q = new URL(url, "http://x").searchParams;
      return json(200, {
        branch: "main",
        changes: 2,
        ...(q.has("tasksDir") && { tasksDir: q.get("tasksDir") === ".agents/tasks" ? { exists: true, taskFiles: 7 } : { exists: false, taskFiles: 0 } }),
        ...(q.has("spec") && { spec: { exists: q.get("spec") === "spec.md" } }),
      });
    }
    if (init?.method === "POST" && post) return post(url, init);
    return json(404, { error: "not found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDrawer(onClose = vi.fn()) {
  render(
    <ToastProvider>
      <StartRunDrawer open onClose={onClose} workspaces={WORKSPACES} initialWorkspace={WS} />
    </ToastProvider>,
  );
  return onClose;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("StartRunDrawer", () => {
  it("shows the inspect results of the workspace and the paths", async () => {
    stub();
    renderDrawer();
    expect((await screen.findByTestId("start-run-ws-info")).textContent).toBe("main · 2 uncommitted files");
    expect((await screen.findByTestId("start-run-tasks-info")).textContent).toBe("7 task files found");
    fireEvent.change(screen.getByTestId("start-run-tasks"), { target: { value: "nope" } });
    await waitFor(() => expect(screen.getByTestId("start-run-tasks-info").textContent).toBe("Not a folder in this workspace"));
    fireEvent.change(screen.getByTestId("start-run-spec"), { target: { value: "missing.md" } });
    expect((await screen.findByTestId("start-run-spec-info")).textContent).toBe("File not found");
  });

  it("starts on the workspace it was opened for", async () => {
    stub();
    render(
      <ToastProvider>
        <StartRunDrawer open onClose={() => {}} workspaces={WORKSPACES} initialWorkspace="github~acme~web" />
      </ToastProvider>,
    );
    await waitFor(() => expect((screen.getByTestId("start-run-workspace") as HTMLSelectElement).value).toBe("github~acme~web"));
  });

  it("updates the command preview with the provider and remembers the last one used", async () => {
    stub(() => json(201, { runId: "gm-1", viewUrl: "/x" }));
    renderDrawer();
    const preview = screen.getByTestId("start-run-command");
    expect(preview.textContent).toBe(commandPreview(".agents/tasks", "", "claude"));
    fireEvent.change(screen.getByTestId("start-run-spec"), { target: { value: "spec.md" } });
    fireEvent.click(screen.getByRole("radio", { name: "fake (test)" }));
    expect(preview.textContent).toBe("graph-execution .agents/tasks \\\n  --spec spec.md \\\n  --provider fake \\\n  --web");
    fireEvent.click(screen.getByTestId("start-run-submit"));
    await waitFor(() => expect(localStorage.getItem(PROVIDER_KEY)).toBe("fake"));
  });

  it("posts the form on Ctrl+Enter, closes and toasts the new run", async () => {
    const fetchMock = stub(() => json(201, { runId: "gm-20261106-120000-abcd", viewUrl: "/x" }));
    const onClose = renderDrawer();
    fireEvent.change(screen.getByTestId("start-run-tasks"), { target: { value: "diamond" } });
    fireEvent.change(screen.getByTestId("start-run-spec"), { target: { value: "spec.md" } });
    fireEvent.click(screen.getByRole("radio", { name: "fake (test)" }));
    fireEvent.keyDown(screen.getByTestId("start-run-spec"), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const sent = fetchMock.mock.calls.find(([, i]) => i?.method === "POST");
    expect(sent?.[0]).toBe(`/api/runs/${WS}`);
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ tasksDir: "diamond", spec: "spec.md", provider: "fake" });
    expect((await screen.findByText("Started run gm-20261106-120000-abcd")).closest(".toast")?.textContent).toContain("Open");
  });

  it("shows the CLI's exit code and output when the start fails", async () => {
    stub(() => json(400, { error: "line 1\nError: spec not found", exitCode: 2, output: "line 1\nError: spec not found" }));
    const onClose = renderDrawer();
    fireEvent.change(screen.getByTestId("start-run-spec"), { target: { value: "spec.md" } });
    fireEvent.click(screen.getByTestId("start-run-submit"));
    const box = await screen.findByTestId("start-run-error");
    expect(box.textContent).toContain("graph-execution exited with code 2");
    expect(box.querySelector("pre")?.textContent).toBe("line 1\nError: spec not found");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the server's error text when the CLI did not run", async () => {
    stub(() => json(400, { error: "spec: nope.md is not a file inside the workspace" }));
    renderDrawer();
    fireEvent.change(screen.getByTestId("start-run-spec"), { target: { value: "nope.md" } });
    fireEvent.click(screen.getByTestId("start-run-submit"));
    expect((await screen.findByTestId("start-run-error")).textContent).toBe("spec: nope.md is not a file inside the workspace");
  });
});
