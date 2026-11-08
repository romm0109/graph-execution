// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/** `defaults`: saved run defaults by workspace id; `gets`: extra GET answers by exact URL (e.g. the sandbox status, a workspace's settings). */
function stub(post?: Handler, defaults: Record<string, unknown> = {}, gets: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== "POST" && url in gets) return json(200, gets[url]);
    if (url.startsWith(`/api/workspaces/${WS}/inspect`)) {
      const q = new URL(url, "http://x").searchParams;
      return json(200, {
        branch: "main",
        changes: 2,
        ...(q.has("tasksDir") && { tasksDir: q.get("tasksDir") === ".agents/tasks" ? { exists: true, taskFiles: 7 } : { exists: false, taskFiles: 0 } }),
        ...(q.has("spec") && { spec: { exists: q.get("spec") === "spec.md" } }),
      });
    }
    const m = /^\/api\/workspaces\/([^/]+)\/run-defaults$/.exec(url);
    if (m && (init?.method ?? "GET") === "GET" && m[1] !== undefined && decodeURIComponent(m[1]) in defaults) {
      return json(200, defaults[decodeURIComponent(m[1])]);
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

  it("sends the options and shows them in the preview (regression KAN-89)", async () => {
    const fetchMock = stub(() => json(201, { runId: "gm-2", viewUrl: "/x" }));
    const onClose = renderDrawer();
    fireEvent.change(screen.getByTestId("start-run-spec"), { target: { value: "spec.md" } });
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Human review" })).getByRole("radio", { name: "On" }));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Merge into my branch" })).getByRole("radio", { name: "Off" }));
    fireEvent.change(screen.getByLabelText("Concurrency"), { target: { value: "5" } });
    const more = screen.getByTestId("start-run-more") as HTMLDetailsElement;
    expect(more.open).toBe(false);
    fireEvent.click(within(more).getByText("More options"));
    fireEvent.change(screen.getByTestId("start-run-fix-passes"), { target: { value: "1" } });
    const options = { merge: false, humanReview: true, concurrency: 5, fixPasses: 1 };
    const preview = screen.getByTestId("start-run-command").textContent ?? "";
    expect(preview).toBe(commandPreview(".agents/tasks", "spec.md", "claude", options));
    expect(preview.split("\n")).toContain("  --fix-passes 1 \\");
    fireEvent.click(screen.getByTestId("start-run-submit"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const sent = fetchMock.mock.calls.find(([, i]) => i?.method === "POST");
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ tasksDir: ".agents/tasks", spec: "spec.md", provider: "claude", options });
  });

  it("fills the form from the workspace's saved choices", async () => {
    localStorage.setItem(PROVIDER_KEY, "codex");
    stub(undefined, { [WS]: { provider: "fake", tasksDir: "diamond", spec: "spec.md", options: { humanReview: true, attempts: 1, validateAt: "end" } } });
    renderDrawer();
    await waitFor(() => expect(screen.getByRole("radio", { name: "fake (test)" }).getAttribute("aria-checked")).toBe("true"));
    expect((screen.getByTestId("start-run-tasks") as HTMLInputElement).value).toBe("diamond");
    expect((screen.getByTestId("start-run-spec") as HTMLInputElement).value).toBe("spec.md");
    const humanReview = screen.getByRole("radiogroup", { name: "Human review" });
    expect(within(humanReview).getByRole("radio", { name: "On" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByTestId("start-run-more") as HTMLDetailsElement).open).toBe(true);
    expect((screen.getByTestId("start-run-attempts") as HTMLInputElement).value).toBe("1");
    expect(within(screen.getByRole("radiogroup", { name: "Validate" })).getByRole("radio", { name: "At the end" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.change(screen.getByTestId("start-run-workspace"), { target: { value: "github~acme~web" } });
    await waitFor(() => expect(within(humanReview).getByRole("radio", { name: "Repo default" }).getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByRole("radio", { name: "codex" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByTestId("start-run-more") as HTMLDetailsElement).open).toBe(false);
  });

  it("applies a prefill over the workspace's saved choices, and keeps the saved options when it has none", async () => {
    stub(undefined, { [WS]: { provider: "codex", tasksDir: "diamond", spec: "spec.md", options: { concurrency: 5 } } });
    const { rerender } = render(
      <ToastProvider>
        <StartRunDrawer open onClose={() => {}} workspaces={WORKSPACES} initialWorkspace={WS} prefill={{ tasksDir: ".agents/tasks/x", spec: "docs/prd/x.md", provider: "fake", options: { concurrency: 3 } }} />
      </ToastProvider>,
    );
    await waitFor(() => expect((screen.getByTestId("start-run-tasks") as HTMLInputElement).value).toBe(".agents/tasks/x"));
    expect((screen.getByTestId("start-run-spec") as HTMLInputElement).value).toBe("docs/prd/x.md");
    expect(screen.getByRole("radio", { name: "fake (test)" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByTestId("start-run-concurrency") as HTMLInputElement).value).toBe("3");

    rerender(
      <ToastProvider>
        <StartRunDrawer open onClose={() => {}} workspaces={WORKSPACES} initialWorkspace={WS} prefill={{ tasksDir: "other", spec: "s.md" }} />
      </ToastProvider>,
    );
    await waitFor(() => expect((screen.getByTestId("start-run-tasks") as HTMLInputElement).value).toBe("other"));
    expect(screen.getByRole("radio", { name: "codex" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByTestId("start-run-concurrency") as HTMLInputElement).value).toBe("5");
  });

  it("merges a prefill's options over the saved options", async () => {
    stub(undefined, { [WS]: { provider: "codex", tasksDir: "diamond", spec: "spec.md", options: { concurrency: 5, attempts: 2 } } });
    render(
      <ToastProvider>
        <StartRunDrawer open onClose={() => {}} workspaces={WORKSPACES} initialWorkspace={WS} prefill={{ tasksDir: "t", spec: "s.md", options: { concurrency: 3 } }} />
      </ToastProvider>,
    );
    await waitFor(() => expect((screen.getByTestId("start-run-concurrency") as HTMLInputElement).value).toBe("3"));
    expect((screen.getByTestId("start-run-attempts") as HTMLInputElement).value).toBe("2");
  });

  it("shows an inline error and disables Start for a bad number", () => {
    stub();
    renderDrawer();
    fireEvent.change(screen.getByTestId("start-run-spec"), { target: { value: "spec.md" } });
    const submit = screen.getByTestId("start-run-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.change(screen.getByTestId("start-run-concurrency"), { target: { value: "0" } });
    expect(screen.getByTestId("start-run-concurrency-error").textContent).toBe("Whole number from 1 to 64");
    expect(screen.getByTestId("start-run-concurrency").getAttribute("aria-invalid")).toBe("true");
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("start-run-concurrency"), { target: { value: "2" } });
    expect(screen.queryByTestId("start-run-concurrency-error")).toBeNull();
    expect(submit.disabled).toBe(false);
  });

  it("shows the server's 400 for a reserved extra argument", async () => {
    const fetchMock = stub(() => json(400, { error: "extra arguments: --web is set by graph-manager" }));
    renderDrawer();
    fireEvent.change(screen.getByTestId("start-run-spec"), { target: { value: "spec.md" } });
    fireEvent.click(within(screen.getByTestId("start-run-more")).getByText("More options"));
    fireEvent.change(screen.getByTestId("start-run-extra-args"), { target: { value: "--web" } });
    fireEvent.click(screen.getByTestId("start-run-submit"));
    expect((await screen.findByTestId("start-run-error")).textContent).toBe("extra arguments: --web is set by graph-manager");
    const sent = fetchMock.mock.calls.find(([, i]) => i?.method === "POST");
    expect(JSON.parse(String(sent?.[1]?.body)).options).toEqual({ extraArgs: "--web" });
  });

  describe("Run in sandbox (KAN-88)", () => {
    const STATUS = "/api/sandbox/status";
    const SETTINGS = `/api/workspaces/${WS}/settings`;
    const toggle = () => screen.getByTestId("start-run-sandbox-toggle") as HTMLInputElement;
    const ok = () => json(201, { runId: "gm-1", viewUrl: "/x" });
    const postedBody = (fetchMock: ReturnType<typeof stub>) =>
      JSON.parse(String(fetchMock.mock.calls.find(([, i]) => i?.method === "POST")?.[1]?.body)) as Record<string, unknown>;

    it("adds --sandbox to the command preview only when on", () => {
      expect(commandPreview("t", "s.md", "fake", {}, true).endsWith("--web \\\n  --sandbox")).toBe(true);
      expect(commandPreview("t", "s.md", "fake")).toBe("graph-execution t \\\n  --spec s.md \\\n  --provider fake \\\n  --web");
    });

    it("is disabled with the server's reason when Docker is not reachable, and posts no sandbox key", async () => {
      const reason = "Docker is not reachable at /var/run/docker.sock: connect ENOENT";
      const fetchMock = stub(ok, {}, { [STATUS]: { available: false, reason }, [SETTINGS]: { image: null, sandbox: true } });
      const onClose = renderDrawer();
      await waitFor(() => expect(screen.getByTestId("start-run-sandbox-reason").textContent).toBe(reason));
      expect(toggle().disabled).toBe(true);
      expect(toggle().checked).toBe(false);
      fireEvent.change(screen.getByTestId("start-run-spec"), { target: { value: "spec.md" } });
      fireEvent.click(screen.getByTestId("start-run-submit"));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(postedBody(fetchMock)).not.toHaveProperty("sandbox");
    });

    it("is disabled when the status cannot be read (404)", async () => {
      stub();
      renderDrawer();
      await waitFor(() => expect(screen.getByTestId("start-run-sandbox-reason").textContent).toBe("Could not read the sandbox status"));
      expect(toggle().disabled).toBe(true);
    });

    it("shows the default image, and turned on adds --sandbox and posts sandbox: true", async () => {
      const fetchMock = stub(ok, {}, { [STATUS]: { available: true, defaultImage: "graph-manager:dev" }, [SETTINGS]: { image: null, sandbox: false } });
      const onClose = renderDrawer();
      await waitFor(() => expect(screen.getByTestId("start-run-sandbox-image").textContent).toBe("Image: graph-manager:dev"));
      expect(toggle().disabled).toBe(false);
      expect(toggle().checked).toBe(false);
      fireEvent.click(toggle());
      expect(toggle().checked).toBe(true);
      expect(screen.getByTestId("start-run-command").textContent?.endsWith("--web \\\n  --sandbox")).toBe(true);
      fireEvent.change(screen.getByTestId("start-run-spec"), { target: { value: "spec.md" } });
      fireEvent.keyDown(screen.getByTestId("start-run-spec"), { key: "Enter", ctrlKey: true });
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(postedBody(fetchMock)).toEqual({ tasksDir: ".agents/tasks", spec: "spec.md", provider: "claude", sandbox: true });
      expect(await screen.findByText("Started run gm-1")).toBeTruthy();
    });

    it("is preselected from the workspace's saved value and shows its image; another workspace starts unchecked", async () => {
      stub(undefined, {}, { [STATUS]: { available: true, defaultImage: "graph-manager:dev" }, [SETTINGS]: { image: "python:3.12-bookworm", sandbox: true } });
      renderDrawer();
      await waitFor(() => expect(toggle().checked).toBe(true));
      expect(screen.getByTestId("start-run-sandbox-image").textContent).toBe("Image: python:3.12-bookworm");
      fireEvent.change(screen.getByTestId("start-run-workspace"), { target: { value: "github~acme~web" } });
      await waitFor(() => expect(toggle().checked).toBe(false));
      expect(screen.getByTestId("start-run-sandbox-image").textContent).toBe("Image: graph-manager:dev");
    });

    it("says there is no image when neither the workspace nor the server has one", async () => {
      stub(undefined, {}, { [STATUS]: { available: true } });
      renderDrawer();
      await waitFor(() => expect(screen.getByTestId("start-run-sandbox-image").textContent).toBe("No image: set one in the workspace's settings"));
    });
  });
});
