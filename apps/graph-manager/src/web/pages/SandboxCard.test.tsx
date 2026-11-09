// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxBuild, SandboxRecipe, SandboxSettings, ToolchainInfo } from "../types";
import { ToastProvider } from "../ui/toast";
import { SandboxCard } from "./SandboxCard";
import { PREVIEW_DEBOUNCE_MS } from "./RecipeEditor";
import { BUILD_POLL_MS } from "./SandboxImage";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const TOOLCHAINS: ToolchainInfo[] = [
  { id: "python", name: "Python", snippet: "RUN apt-get install -y python3" },
  { id: "java", name: "Java", snippet: "RUN apt-get install -y default-jdk-headless" },
  { id: "go", name: "Go", snippet: "COPY --from=golang:1-bookworm /usr/local/go /usr/local/go" },
  { id: "rust", name: "Rust", snippet: "RUN curl https://sh.rustup.rs | sh" },
  { id: "ruby", name: "Ruby", snippet: "RUN apt-get install -y ruby-full" },
  { id: "php", name: "PHP", snippet: "RUN apt-get install -y php-cli" },
  { id: "cpp", name: "C/C++", snippet: "RUN apt-get install -y build-essential" },
];
const DEFAULT_RECIPE: SandboxRecipe = {
  base: "node:24-bookworm",
  toolchains: TOOLCHAINS.map((t) => ({ id: t.id, enabled: false, snippet: t.snippet })),
  extraLines: "",
};
const withPython = (r: SandboxRecipe): SandboxRecipe => ({ ...r, toolchains: r.toolchains.map((t) => (t.id === "python" ? { ...t, enabled: true } : t)) });
const dockerfileOf = (r: SandboxRecipe) => [`FROM ${r.base}`, ...r.toolchains.filter((t) => t.enabled).map((t) => t.snippet), r.extraLines].join("\n");
const settingsOf = (recipe: SandboxRecipe = DEFAULT_RECIPE): SandboxSettings => ({
  limits: { cpus: 2, memoryMb: 4096, pids: 512 },
  recipe,
  defaultRecipe: DEFAULT_RECIPE,
  toolchains: TOOLCHAINS,
  dockerfile: dockerfileOf(recipe),
  image: recipe === DEFAULT_RECIPE ? "gm-sandbox:abc123def456" : "gm-sandbox:fed654cba321",
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
    if (url === "/api/sandbox/dockerfile" && method === "POST") {
      const { recipe } = body as { recipe: SandboxRecipe };
      return json(200, { dockerfile: dockerfileOf(recipe), image: "gm-sandbox:preview" });
    }
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
  it("shows the recipe, the toolchains, the Dockerfile preview and the build state", async () => {
    stub();
    renderCard();
    await waitFor(() => expect(el<HTMLInputElement>("recipe-base").value).toBe("node:24-bookworm"));
    const names = Array.from(el("recipe-toolchains").querySelectorAll("li > label")).map((l) => l.textContent);
    expect(names).toEqual(["Python", "Java", "Go", "Rust", "Ruby", "PHP", "C/C++"]);
    for (const t of TOOLCHAINS) expect(el<HTMLInputElement>(`toolchain-${t.id}-enabled`).checked).toBe(false);
    expect(el<HTMLTextAreaElement>("recipe-extra").value).toBe("");
    await waitFor(() => expect(el("recipe-dockerfile").textContent).toContain("FROM node:24-bookworm"));
    expect(el("sandbox-saved-image").textContent).toBe("Saved image: gm-sandbox:abc123def456");
    await waitFor(() => expect(el("sandbox-build-state").textContent).toBe("ready"));
    expect(el<HTMLButtonElement>("sandbox-save-recipe").disabled).toBe(true);
    expect(el<HTMLButtonElement>("sandbox-reset-recipe").disabled).toBe(true);
    expect(screen.queryByTestId("sandbox-build-log")).toBeNull();
  });

  it("ticking a toolchain updates the preview after the debounce", async () => {
    const fetchMock = stub();
    renderCard();
    await waitFor(() => expect(el("recipe-dockerfile").textContent).toBe("FROM node:24-bookworm\n"));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(el("toolchain-python-enabled"));
    act(() => vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS));
    await waitFor(() => expect(el("recipe-dockerfile").textContent).toContain("RUN apt-get install -y python3"));
    expect(calls(fetchMock, "/api/sandbox/dockerfile", "POST").at(-1)).toEqual({ recipe: withPython(DEFAULT_RECIPE) });
  });

  it("Save and rebuild sends the edited recipe, then polls the build until it is ready", async () => {
    const saved = withPython(DEFAULT_RECIPE);
    const fetchMock = stub({
      put: () => json(200, settingsOf(saved)),
      builds: [
        { state: "ready", log: [] },
        { state: "queued", log: [] },
        { state: "building", step: "image", log: ["Step 1/3 : FROM node:24-bookworm"] },
        { state: "ready", log: ["Step 1/3 : FROM node:24-bookworm", "Step 2/3 : RUN apt-get install", "Successfully built"] },
      ],
    });
    renderCard();
    await waitFor(() => expect(el("sandbox-build-state").textContent).toBe("ready"));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(el("toolchain-python-enabled"));
    expect(el<HTMLButtonElement>("sandbox-save-recipe").disabled).toBe(false);
    fireEvent.click(el("sandbox-save-recipe"));
    await waitFor(() => expect(el("sandbox-build-state").textContent).toBe("queued"));
    expect(calls(fetchMock, "/api/settings/sandbox", "PUT")).toEqual([{ recipe: saved }]);
    expect(await screen.findByText("Saved the sandbox image recipe")).toBeTruthy();
    expect(el("sandbox-saved-image").textContent).toBe("Saved image: gm-sandbox:fed654cba321");
    expect(el<HTMLInputElement>("toolchain-python-enabled").checked).toBe(true);
    expect(el<HTMLButtonElement>("sandbox-rebuild").disabled).toBe(true);
    expect(el<HTMLButtonElement>("sandbox-save-recipe").disabled).toBe(true);
    expect(el<HTMLInputElement>("toolchain-python-enabled").disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BUILD_POLL_MS);
    });
    await waitFor(() => expect(el("sandbox-build-state").textContent).toBe("building (image)"));
    expect(el("sandbox-build-log").textContent).toBe("Step 1/3 : FROM node:24-bookworm");
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
    await waitFor(() => expect(el<HTMLInputElement>("recipe-base").value).toBe("node:24-bookworm"));
    fireEvent.change(el("recipe-extra"), { target: { value: "FROM ubuntu" } });
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
    const custom = withPython(DEFAULT_RECIPE);
    const fetchMock = stub({ settings: settingsOf(custom), put: () => json(200, settingsOf()) });
    renderCard();
    await waitFor(() => expect(el<HTMLInputElement>("toolchain-python-enabled").checked).toBe(true));
    expect(el<HTMLButtonElement>("sandbox-reset-recipe").disabled).toBe(false);
    fireEvent.click(el("sandbox-reset-recipe"));
    await waitFor(() => expect(el<HTMLInputElement>("toolchain-python-enabled").checked).toBe(false));
    expect(calls(fetchMock, "/api/settings/sandbox", "PUT")).toEqual([{ recipe: null }]);
    expect(await screen.findByText("Reset the sandbox image recipe to the defaults")).toBeTruthy();
    expect(el<HTMLButtonElement>("sandbox-reset-recipe").disabled).toBe(true);
  });
});
