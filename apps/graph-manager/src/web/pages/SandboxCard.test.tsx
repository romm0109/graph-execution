// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxBuild, SandboxRecipe, SandboxSettings } from "../types";
import { ToastProvider } from "../ui/toast";
import { SandboxCard } from "./SandboxCard";
import { BUILD_POLL_MS } from "./SandboxImage";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const DEFAULT_RECIPE: SandboxRecipe = { base: "node:24-bookworm", packages: ["python3", "git"], extraLines: "COPY --from=golang:1.25 /usr/local/go /usr/local/go" };
const settingsOf = (recipe: SandboxRecipe = DEFAULT_RECIPE): SandboxSettings => ({
  limits: { cpus: 2, memoryMb: 4096, pids: 512 },
  recipe,
  defaultRecipe: DEFAULT_RECIPE,
  dockerfile: `FROM ${recipe.base}\nRUN apt-get install -y ${recipe.packages.join(" ")}\n${recipe.extraLines}`,
});

type Handler = (body: unknown) => Response;

/** Answers the card's requests. `builds` is a queue of `GET /api/sandbox/build` answers; the last one repeats. */
function stub(opts: { settings?: SandboxSettings; builds?: SandboxBuild[]; put?: Handler; rebuild?: Handler } = {}) {
  const builds = [...(opts.builds ?? [{ state: "ready", log: [] }])];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    if (url === "/api/sandbox/status") return json(200, { available: true, defaultImage: "gm-sandbox:abc123def456" });
    if (url === "/api/settings/sandbox" && method === "GET") return json(200, opts.settings ?? settingsOf());
    if (url === "/api/settings/sandbox" && method === "PUT" && opts.put) return opts.put(body);
    if (url === "/api/sandbox/rebuild" && method === "POST" && opts.rebuild) return opts.rebuild(body);
    if (url === "/api/sandbox/build") return json(200, builds.length > 1 ? builds.shift() : builds[0]);
    return json(404, { error: "not found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const calls = (fetchMock: ReturnType<typeof stub>, url: string, method: string) =>
  fetchMock.mock.calls.filter(([u, i]) => u === url && (i?.method ?? "GET") === method).map(([, i]) => JSON.parse(String(i?.body ?? "null")) as unknown);

const renderCard = () =>
  render(
    <ToastProvider>
      <SandboxCard />
    </ToastProvider>,
  );

const el = <T extends HTMLElement = HTMLElement>(id: string) => screen.getByTestId(id) as T;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SandboxCard: image", () => {
  it("shows the recipe, the Dockerfile preview and the build state", async () => {
    stub();
    renderCard();
    await waitFor(() => expect(el<HTMLInputElement>("sandbox-base").value).toBe("node:24-bookworm"));
    expect(el<HTMLTextAreaElement>("sandbox-packages").value).toBe("python3\ngit");
    expect(el<HTMLTextAreaElement>("sandbox-extra").value).toBe(DEFAULT_RECIPE.extraLines);
    expect(el("sandbox-dockerfile").textContent).toContain("FROM node:24-bookworm");
    await waitFor(() => expect(el("sandbox-build-state").textContent).toBe("ready"));
    expect(el<HTMLButtonElement>("sandbox-save-recipe").disabled).toBe(true);
    expect(el<HTMLButtonElement>("sandbox-reset-recipe").disabled).toBe(true);
    expect(screen.queryByTestId("sandbox-build-log")).toBeNull();
  });

  it("Save and rebuild sends the edited recipe, then polls the build until it is ready", async () => {
    const saved: SandboxRecipe = { ...DEFAULT_RECIPE, packages: ["python3", "git", "golang"] };
    const fetchMock = stub({
      put: () => json(200, settingsOf(saved)),
      builds: [
        { state: "ready", log: [] },
        { state: "building", step: "image", log: ["Step 1/3 : FROM node:24-bookworm"] },
        { state: "building", step: "image", log: ["Step 1/3 : FROM node:24-bookworm", "Step 2/3 : RUN apt-get install"] },
        { state: "ready", log: ["Step 1/3 : FROM node:24-bookworm", "Step 2/3 : RUN apt-get install", "Successfully built"] },
      ],
    });
    renderCard();
    await waitFor(() => expect(el("sandbox-build-state").textContent).toBe("ready"));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.change(el("sandbox-packages"), { target: { value: "python3\ngit\n golang \n\n" } });
    expect(el<HTMLButtonElement>("sandbox-save-recipe").disabled).toBe(false);
    fireEvent.click(el("sandbox-save-recipe"));
    await waitFor(() => expect(el("sandbox-build-state").textContent).toBe("building (image)"));
    expect(calls(fetchMock, "/api/settings/sandbox", "PUT")).toEqual([{ recipe: saved }]);
    expect(await screen.findByText("Saved the sandbox image recipe")).toBeTruthy();
    expect(el("sandbox-build-log").textContent).toBe("Step 1/3 : FROM node:24-bookworm");
    expect(el<HTMLButtonElement>("sandbox-rebuild").disabled).toBe(true);
    expect(el<HTMLButtonElement>("sandbox-save-recipe").disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BUILD_POLL_MS);
    });
    await waitFor(() => expect(el("sandbox-build-log").textContent).toContain("Step 2/3"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BUILD_POLL_MS);
    });
    await waitFor(() => expect(el("sandbox-build-state").textContent).toBe("ready"));
    expect(el("sandbox-build-log").textContent).toContain("Successfully built");
    expect(el<HTMLButtonElement>("sandbox-rebuild").disabled).toBe(false);
    // The card re-reads the status when the build finished.
    expect(calls(fetchMock, "/api/sandbox/status", "GET").length).toBeGreaterThan(1);
  });

  it("shows the server's error for an invalid recipe", async () => {
    stub({ put: () => json(400, { error: "extraLines: FROM is not allowed; use COPY --from=<image>" }) });
    renderCard();
    await waitFor(() => expect(el<HTMLInputElement>("sandbox-base").value).toBe("node:24-bookworm"));
    fireEvent.change(el("sandbox-extra"), { target: { value: "FROM ubuntu" } });
    fireEvent.click(el("sandbox-save-recipe"));
    await waitFor(() => expect(el("sandbox-recipe-error").textContent).toBe("extraLines: FROM is not allowed; use COPY --from=<image>"));
    expect(el("sandbox-recipe-error").getAttribute("role")).toBe("alert");
  });

  it("Rebuild posts to /api/sandbox/rebuild and is disabled while building", async () => {
    const building: SandboxBuild = { state: "building", step: "clis", log: ["installing the CLIs"] };
    const fetchMock = stub({ rebuild: () => json(202, { build: building }), builds: [{ state: "ready", log: [] }, building] });
    renderCard();
    await waitFor(() => expect(el("sandbox-build-state").textContent).toBe("ready"));
    expect(el("sandbox-rebuild").getAttribute("title")).toBe("Rebuilds the image and the provider CLIs without the cache");
    fireEvent.click(el("sandbox-rebuild"));
    await waitFor(() => expect(el("sandbox-build-state").textContent).toBe("building (CLIs)"));
    expect(calls(fetchMock, "/api/sandbox/rebuild", "POST")).toHaveLength(1);
    expect(el<HTMLButtonElement>("sandbox-rebuild").disabled).toBe(true);
  });

  it("shows the error of a 409 rebuild", async () => {
    stub({ rebuild: () => json(409, { error: "the sandbox image is building" }) });
    renderCard();
    await waitFor(() => expect(el("sandbox-build-state").textContent).toBe("ready"));
    fireEvent.click(el("sandbox-rebuild"));
    await waitFor(() => expect(el("sandbox-recipe-error").textContent).toBe("the sandbox image is building"));
  });

  it("shows the error of a failed build", async () => {
    stub({ builds: [{ state: "failed", step: "image", error: "E: Unable to locate package nope", log: ["Step 2/3 : RUN apt-get install nope"] }] });
    renderCard();
    await waitFor(() => expect(el("sandbox-build-state").textContent).toBe("failed"));
    expect(el("sandbox-build-error").textContent).toBe("E: Unable to locate package nope");
    expect(el("sandbox-build-log").textContent).toContain("apt-get install nope");
  });

  it("Reset to defaults sends recipe: null", async () => {
    const custom: SandboxRecipe = { ...DEFAULT_RECIPE, packages: ["ruby"] };
    const fetchMock = stub({ settings: settingsOf(custom), put: () => json(200, settingsOf()) });
    renderCard();
    await waitFor(() => expect(el<HTMLTextAreaElement>("sandbox-packages").value).toBe("ruby"));
    expect(el<HTMLButtonElement>("sandbox-reset-recipe").disabled).toBe(false);
    fireEvent.click(el("sandbox-reset-recipe"));
    await waitFor(() => expect(el<HTMLTextAreaElement>("sandbox-packages").value).toBe("python3\ngit"));
    expect(calls(fetchMock, "/api/settings/sandbox", "PUT")).toEqual([{ recipe: null }]);
    expect(el<HTMLButtonElement>("sandbox-reset-recipe").disabled).toBe(true);
  });
});
