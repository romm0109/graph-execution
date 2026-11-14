// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEntry } from "../types";
import { ToastProvider } from "../ui/toast";
import { PROVIDER_KEY, SANDBOX_STATUS_POLL_MS, StartRunDrawer, commandPreview, projectCommandPreview } from "./StartRunDrawer";

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

    describe("a remote (hosted) session", () => {
      const READY_STATUS = { available: true, defaultImage: "graph-manager:dev" };
      const SAVED = { source: "global", recipe: null, dockerfile: null, image: null, effectiveImage: "graph-manager:dev", sandbox: true };
      /** `stub`, with the inspect answer of a hosted session. */
      function stubHosted(inspect: Record<string, unknown>) {
        const base = stub(ok, {}, { [STATUS]: READY_STATUS, [SETTINGS]: SAVED });
        const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
          url.startsWith(`/api/workspaces/${WS}/inspect`) ? json(200, { branch: "gm/s", changes: 2, ...inspect }) : base(url, init),
        );
        vi.stubGlobal("fetch", fetchMock);
        return fetchMock;
      }

      it("hides the toggle, warns about uncommitted changes and posts no sandbox key", async () => {
        const fetchMock = stubHosted({ hosted: true, repo: "acme/api" });
        const onClose = renderDrawer();
        expect((await screen.findByTestId("start-run-hosted-warning")).textContent).toBe("Uncommitted changes in acme/api are not part of the run.");
        expect(screen.queryByTestId("start-run-sandbox")).toBeNull();
        expect(screen.queryByTestId("start-run-sandbox-toggle")).toBeNull();
        expect(screen.getByTestId("start-run-command").textContent).not.toContain("--sandbox");
        fireEvent.change(screen.getByTestId("start-run-spec"), { target: { value: "spec.md" } });
        fireEvent.click(screen.getByTestId("start-run-submit"));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(postedBody(fetchMock)).not.toHaveProperty("sandbox");
      });

      it("shows no warning without uncommitted changes", async () => {
        stubHosted({ hosted: true, repo: "acme/api", changes: 0 });
        renderDrawer();
        await waitFor(() => expect(screen.getByTestId("start-run-ws-info").textContent).toBe("gm/s · 0 uncommitted files"));
        expect(screen.queryByTestId("start-run-hosted-warning")).toBeNull();
        expect(screen.queryByTestId("start-run-sandbox")).toBeNull();
      });

      it("keeps the toggle for a local session", async () => {
        stubHosted({});
        renderDrawer();
        await waitFor(() => expect(toggle().disabled).toBe(false));
        expect(screen.queryByTestId("start-run-hosted-warning")).toBeNull();
      });
    });

    it("is disabled with the server's reason when Docker is not reachable, and posts no sandbox key", async () => {
      const reason = "Docker is not reachable at /var/run/docker.sock: connect ENOENT";
      const fetchMock = stub(
        ok,
        {},
        {
          [STATUS]: { available: false, reason },
          [SETTINGS]: { source: "global", recipe: null, dockerfile: null, image: null, effectiveImage: "graph-manager:dev", sandbox: true },
        },
      );
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
      const fetchMock = stub(
        ok,
        {},
        {
          [STATUS]: { available: true, defaultImage: "graph-manager:dev" },
          [SETTINGS]: { source: "global", recipe: null, dockerfile: null, image: null, effectiveImage: "graph-manager:dev", sandbox: false },
        },
      );
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
      stub(
        undefined,
        {},
        {
          [STATUS]: { available: true, defaultImage: "graph-manager:dev" },
          [SETTINGS]: { source: "image", recipe: null, dockerfile: null, image: "python:3.12-bookworm", effectiveImage: "python:3.12-bookworm", sandbox: true },
        },
      );
      renderDrawer();
      await waitFor(() => expect(toggle().checked).toBe(true));
      expect(screen.getByTestId("start-run-sandbox-image").textContent).toBe("Image: python:3.12-bookworm");
      fireEvent.change(screen.getByTestId("start-run-workspace"), { target: { value: "github~acme~web" } });
      await waitFor(() => expect(toggle().checked).toBe(false));
      expect(screen.getByTestId("start-run-sandbox-image").textContent).toBe("Image: graph-manager:dev");
    });

    it("is disabled while the sandbox image builds, and enabled once a status poll says available", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        let status: unknown = { available: false, building: true, reason: "building the sandbox image" };
        const fetchMock = stub(
          undefined,
          {},
          { [SETTINGS]: { source: "global", recipe: null, dockerfile: null, image: null, effectiveImage: "gm-sandbox:abc123def456", sandbox: false } },
        );
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (url === STATUS ? json(200, status) : base(url, init)));
        renderDrawer();
        await waitFor(() => expect(screen.getByTestId("start-run-sandbox-reason").textContent).toBe("Building the sandbox image… (Settings → Sandbox)"));
        expect(toggle().disabled).toBe(true);
        status = { available: true, defaultImage: "gm-sandbox:abc123def456" };
        await act(async () => {
          await vi.advanceTimersByTimeAsync(SANDBOX_STATUS_POLL_MS);
        });
        await waitFor(() => expect(toggle().disabled).toBe(false));
        expect(screen.getByTestId("start-run-sandbox-image").textContent).toBe("Image: gm-sandbox:abc123def456");
      } finally {
        vi.useRealTimers();
      }
    });

    it("says there is no image when neither the workspace nor the server has one", async () => {
      stub(undefined, {}, { [STATUS]: { available: true } });
      renderDrawer();
      await waitFor(() => expect(screen.getByTestId("start-run-sandbox-image").textContent).toBe("No image: set one in the workspace's settings"));
    });

    describe("a workspace with its own recipe", () => {
      const BUILD = `/api/workspaces/${WS}/sandbox/build`;
      const RECIPE = { base: "node:22-bookworm", toolchains: [{ id: "java", enabled: true, snippet: "RUN true" }], extraLines: "" };
      const recipeSettings = {
        source: "recipe",
        recipe: RECIPE,
        dockerfile: "FROM node:22-bookworm",
        image: null,
        effectiveImage: "gm-sandbox-ws:0123456789ab",
        sandbox: false,
      };

      it("is disabled while the workspace's own image builds", async () => {
        stub(
          undefined,
          {},
          {
            [STATUS]: { available: true, defaultImage: "graph-manager:dev" },
            [SETTINGS]: recipeSettings,
            [BUILD]: { state: "building", step: "image", log: [] },
          },
        );
        renderDrawer();
        await waitFor(() =>
          expect(screen.getByTestId("start-run-sandbox-reason").textContent).toBe("Building this repository's sandbox image… (Settings → Repositories)"),
        );
        expect(toggle().disabled).toBe(true);
      });

      it("says so when the workspace's own image build failed", async () => {
        stub(undefined, {}, { [STATUS]: { available: true }, [SETTINGS]: recipeSettings, [BUILD]: { state: "failed", error: "boom", log: [] } });
        renderDrawer();
        await waitFor(() =>
          expect(screen.getByTestId("start-run-sandbox-reason").textContent).toBe("The repository's sandbox image build failed (Settings → Repositories)"),
        );
        expect(toggle().disabled).toBe(true);
      });

      it("stays disabled while the global build still makes the CLIs, even when its own build is ready", async () => {
        stub(undefined, {}, { [STATUS]: { available: false, building: true }, [SETTINGS]: recipeSettings, [BUILD]: { state: "ready", log: [] } });
        renderDrawer();
        await waitFor(() => expect(screen.getByTestId("start-run-sandbox-reason").textContent).toBe("Building the sandbox image… (Settings → Sandbox)"));
        expect(toggle().disabled).toBe(true);
      });

      it("is enabled once its build is ready, even while the global image builds, and shows its image", async () => {
        stub(undefined, {}, {
          [STATUS]: { available: false, building: true, clisReady: true },
          [SETTINGS]: recipeSettings,
          [BUILD]: { state: "ready", log: [] },
        });
        renderDrawer();
        await waitFor(() => expect(toggle().disabled).toBe(false));
        expect(screen.getByTestId("start-run-sandbox-image").textContent).toBe("Image: gm-sandbox-ws:0123456789ab");
      });

      it("polls its build every 5 s and enables the switch when it is ready", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
          let build: unknown = { state: "queued", log: [] };
          const fetchMock = stub(undefined, {}, { [STATUS]: { available: true }, [SETTINGS]: recipeSettings });
          const base = fetchMock.getMockImplementation()!;
          fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (url === BUILD ? json(200, build) : base(url, init)));
          renderDrawer();
          await waitFor(() =>
            expect(screen.getByTestId("start-run-sandbox-reason").textContent).toBe("Building this repository's sandbox image… (Settings → Repositories)"),
          );
          build = { state: "ready", log: [] };
          await act(async () => {
            await vi.advanceTimersByTimeAsync(SANDBOX_STATUS_POLL_MS);
          });
          await waitFor(() => expect(toggle().disabled).toBe(false));
          expect(screen.getByTestId("start-run-sandbox-image").textContent).toBe("Image: gm-sandbox-ws:0123456789ab");
        } finally {
          vi.useRealTimers();
        }
      });
    });
  });

  describe("for a project", () => {
    const HOME = "project~billing";
    const PROJECTS = { projects: [{ id: "billing", name: "billing", forge: "github", path: "/ws/.projects/billing", createdAt: "", workspaces: [] }] };
    const INSPECT = "/api/projects/billing/inspect";
    const READY = {
      id: "billing",
      name: "billing",
      contract: true,
      testPlan: false,
      repos: [
        { name: "api", workspaceId: "github~acme~api", fullPath: "acme/api", branch: "main", changes: 0, spec: true, taskFiles: 3 },
        { name: "web", workspaceId: "github~acme~web", fullPath: "acme/web", branch: "main", changes: 0, spec: false },
      ],
    };
    const renderFor = (initial: string, prefill?: { provider?: string; options?: unknown }) =>
      render(
        <ToastProvider>
          <StartRunDrawer open onClose={() => {}} workspaces={WORKSPACES} initialWorkspace={initial} prefill={prefill} />
        </ToastProvider>,
      );
    const select = () => screen.getByTestId("start-run-workspace") as HTMLSelectElement;
    const submit = () => screen.getByTestId("start-run-submit") as HTMLButtonElement;

    it("prints the suite command of a project", () => {
      expect(projectCommandPreview("claude")).toBe("graph-execution suite \\\n  --project . \\\n  --provider claude \\\n  --web");
      expect(projectCommandPreview("fake", { humanReview: true, concurrency: 2 })).toBe(
        "graph-execution suite \\\n  --project . \\\n  --provider fake \\\n  --human-review \\\n  --concurrency 2 \\\n  --web",
      );
    });

    it("offers the projects after the workspaces", async () => {
      stub(undefined, {}, { "/api/projects": PROJECTS });
      renderDrawer();
      await waitFor(() => expect([...select().options].map((o) => o.value)).toEqual([WS, "github~acme~web", HOME]));
      expect(select().querySelector("optgroup")?.getAttribute("label")).toBe("Projects");
      expect(select().value).toBe(WS);
      expect(screen.queryByTestId("start-run-project-checks")).toBeNull();
    });

    it("shows each repo's checks plus the contract and test plan, and posts the project start", async () => {
      const posts: { url: string; body: unknown }[] = [];
      stub(
        (url, init) => {
          posts.push({ url, body: JSON.parse(String(init?.body)) });
          return json(201, { runId: "suite-20261113-120000-abcd" });
        },
        { [HOME]: { provider: "fake", tasksDir: "", spec: "", options: { humanReview: true, attempts: 4 } } },
        { "/api/projects": PROJECTS, [INSPECT]: READY, [`/api/workspaces/${HOME}/settings`]: { sandbox: true, source: "global", image: null, recipe: null, dockerfile: null, effectiveImage: "img:1" }, "/api/sandbox/status": { available: true } },
      );
      renderFor(HOME);
      const checks = await screen.findByTestId("start-run-project-checks");
      expect(select().value).toBe(HOME);
      expect((await within(checks).findByTestId("start-run-repo-api")).textContent).toBe("apispecs/api.md ✓tasks/api/ · 3 task files");
      expect(within(checks).getByTestId("start-run-repo-web").textContent).toBe("webno tasks (unchanged)");
      expect(within(checks).getByTestId("start-run-contract").textContent).toBe("contract.md ✓");
      expect(within(checks).getByTestId("start-run-test-plan").textContent).toContain("test-plan.json");
      expect(within(checks).getByTestId("start-run-test-plan").querySelector(".field-error")).toBeNull();
      // No paths, only the options a project run takes; the sandbox switch as for a workspace.
      expect(screen.queryByTestId("start-run-tasks")).toBeNull();
      expect(screen.queryByTestId("start-run-spec")).toBeNull();
      expect(screen.queryByTestId("start-run-attempts")).toBeNull();
      expect(screen.getByTestId("start-run-extra-args")).toBeTruthy();
      const toggle = screen.getByTestId("start-run-sandbox-toggle") as HTMLInputElement;
      await waitFor(() => expect(toggle.disabled).toBe(false));
      await waitFor(() => expect(toggle.checked).toBe(true));
      expect(screen.queryByTestId("start-run-sandbox-reason")).toBeNull();
      expect(screen.getByTestId("start-run-sandbox-image").parentElement!.textContent).toContain("its own container, sees the project and its repos");
      await waitFor(() =>
        expect(screen.getByTestId("start-run-command").textContent).toBe(
          "graph-execution suite \\\n  --project . \\\n  --provider fake \\\n  --human-review \\\n  --web",
        ),
      );
      await waitFor(() => expect(submit().disabled).toBe(false));
      fireEvent.click(submit());
      await screen.findByText("Started project run suite-20261113-120000-abcd");
      expect(posts).toEqual([{ url: `/api/runs/${encodeURIComponent(HOME)}`, body: { provider: "fake", options: { humanReview: true }, sandbox: true } }]);
    });

    it("cannot start without a contract, or without a repo that has a spec and tasks", async () => {
      const inspect = { ...READY, contract: false };
      stub(undefined, {}, { "/api/projects": PROJECTS, [INSPECT]: inspect });
      renderFor(HOME);
      expect((await screen.findByTestId("start-run-contract")).textContent).toContain("contract.md ✗");
      expect(submit().disabled).toBe(true);
      cleanup();

      stub(undefined, {}, { "/api/projects": PROJECTS, [INSPECT]: { ...READY, repos: [{ name: "api", spec: false, taskFiles: 2 }, { name: "web", spec: true, taskFiles: 0 }] } });
      renderFor(HOME);
      expect((await screen.findByTestId("start-run-repo-api")).textContent).toBe("apispecs/api.md ✗tasks/api/ · 2 task files");
      expect(screen.getByTestId("start-run-repo-web").textContent).toBe("webspecs/web.md ✓tasks/web/ · 0 task files");
      expect(screen.getByTestId("start-run-project-error").textContent).toBe("No repo has both a spec and task files");
      expect(submit().disabled).toBe(true);
    });

    it("keeps a project it was opened for while the projects load, and falls back when it is not one of them", async () => {
      let release: (r: Response) => void = () => {};
      const fetchMock = stub(undefined, {}, { [INSPECT]: READY });
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((url: string, init?: RequestInit) =>
        url === "/api/projects" ? new Promise<Response>((resolve) => (release = resolve)) : base(url, init),
      );
      renderFor(HOME);
      await screen.findByTestId("start-run-project-checks");
      expect(select().value).toBe(HOME);
      await act(async () => release(json(200, PROJECTS)));
      expect(select().value).toBe(HOME);
      cleanup();

      stub(undefined, {}, { "/api/projects": PROJECTS });
      renderFor("project~gone");
      await waitFor(() => expect(select().value).toBe(WS));
      expect(screen.queryByTestId("start-run-project-checks")).toBeNull();
    });

    it("applies an agent's provider and options and leaves the paths alone", async () => {
      stub(undefined, {}, { "/api/projects": PROJECTS, [INSPECT]: READY });
      renderFor(HOME, { provider: "fake", options: { concurrency: 3 } });
      await screen.findByTestId("start-run-project-checks");
      await waitFor(() => expect((screen.getByTestId("start-run-concurrency") as HTMLInputElement).value).toBe("3"));
      expect(screen.getByRole("radio", { name: "fake (test)" }).getAttribute("aria-checked")).toBe("true");
      // Back on a workspace, the paths are the defaults: the prefill set none.
      fireEvent.change(select(), { target: { value: WS } });
      await waitFor(() => expect((screen.getByTestId("start-run-tasks") as HTMLInputElement).value).toBe(".agents/tasks"));
      expect((screen.getByTestId("start-run-spec") as HTMLInputElement).value).toBe("");
    });
  });
});
