// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewProvider } from "./overview";
import Settings, { disconnectBody } from "./pages/Settings";
import { THEME_KEY } from "./ui/theme";
import { ToastProvider } from "./ui/toast";

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })),
  );
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(THEME_KEY);
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Forge = Record<string, unknown>;

interface SandboxFake {
  status?: Record<string, unknown>;
  limits?: { cpus: number; memoryMb: number; pids: number };
  putError?: string;
}

function fakeApi(initial: { github?: Forge; gitlab?: Forge } = {}, sandbox?: SandboxFake) {
  const state = { github: initial.github ?? { connected: false }, gitlab: initial.gitlab ?? { connected: false } };
  let limits = sandbox?.limits ?? { cpus: 2, memoryMb: 4096, pids: 2048 };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/forges" && method === "GET") return json(state);
    if (url === "/api/runs") return json({ runs: [] });
    if (url === "/api/terminals") return json({ terminals: [] });
    if (url === "/api/workspaces") return json({ workspaces: [] });
    if (sandbox && url === "/api/sandbox/status") return json(sandbox.status ?? { available: true, defaultImage: "ghcr.io/acme/graph-manager:1.2.3" });
    if (sandbox && url === "/api/settings/sandbox" && method === "GET") return json({ limits });
    if (sandbox && url === "/api/settings/sandbox" && method === "PUT") {
      if (sandbox.putError) return json({ error: sandbox.putError }, 400);
      limits = JSON.parse(String(init?.body)) as typeof limits;
      return json({ limits });
    }
    if (url === "/api/forges/github" && method === "PUT") {
      const { token } = JSON.parse(String(init?.body)) as { token: string };
      if (token !== "ghp_good_abcd") return json({ error: "GitHub 401: Bad credentials" }, 400);
      state.github = { connected: true, login: "octo", apiUrl: "https://api.github.com", tokenEnd: "abcd" };
      return json(state.github);
    }
    if (url === "/api/forges/gitlab" && method === "PUT") {
      const { baseUrl } = JSON.parse(String(init?.body)) as { baseUrl: string };
      state.gitlab = { connected: true, login: "gitlab-user", baseUrl, apiUrl: baseUrl, tokenEnd: "wxyz" };
      return json(state.gitlab);
    }
    if (url === "/api/forges/github" && method === "DELETE") {
      state.github = { connected: false };
      return new Response(null, { status: 204 });
    }
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  render(
    <ToastProvider>
      <OverviewProvider>
        <Settings />
      </OverviewProvider>
    </ToastProvider>,
  );
}

const calls = (fetchMock: ReturnType<typeof fakeApi>, method: string, url: string) =>
  fetchMock.mock.calls.filter(([u, init]) => u === url && (init?.method ?? "GET") === method);

describe("Settings", () => {
  it("shows the header and both cards with their status chips", async () => {
    fakeApi({ github: { connected: true, login: "octo", apiUrl: "https://api.github.com", tokenEnd: "abcd" } });
    renderPage();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByText(/Tokens are stored on the server and never shown again after saving\./)).toBeTruthy();
    const gh = screen.getByTestId("forge-github");
    expect((await within(gh).findByTestId("forge-status")).textContent).toBe("connected");
    expect(within(screen.getByTestId("forge-gitlab")).getByTestId("forge-status").textContent).toBe("not connected");
  });

  it("shows login, apiUrl and the token end on a connected card", async () => {
    fakeApi({ github: { connected: true, login: "octo", apiUrl: "https://api.github.com", tokenEnd: "abcd" } });
    renderPage();
    const card = screen.getByTestId("forge-github");
    expect((await within(card).findByText(/Connected as/)).textContent).toBe("Connected as octo");
    expect(within(card).getByTestId("forge-meta").textContent).toBe("https://api.github.com · token ends ••••abcd");
  });

  it("asks before disconnecting; Cancel keeps it, Disconnect sends DELETE", async () => {
    const fetchMock = fakeApi({ github: { connected: true, login: "octo", apiUrl: "https://api.github.com", tokenEnd: "abcd" } });
    renderPage();
    const card = screen.getByTestId("forge-github");
    fireEvent.click(await within(card).findByTestId("disconnect"));
    let dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Disconnect GitHub?")).toBeTruthy();
    expect(within(dialog).getByText(disconnectBody)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /Cancel/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls(fetchMock, "DELETE", "/api/forges/github")).toHaveLength(0);

    fireEvent.click(within(card).getByTestId("disconnect"));
    dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(await within(card).findByTestId("token-input")).toBeTruthy();
    expect(calls(fetchMock, "DELETE", "/api/forges/github")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(card).getByTestId("forge-status").textContent).toBe("not connected");
  });

  it("shows a failed connect's server error inline and keeps the token, then connects", async () => {
    fakeApi();
    renderPage();
    const card = screen.getByTestId("forge-github");
    const input = (await within(card).findByTestId("token-input")) as HTMLInputElement;
    expect(within(card).getByText(/scope\./).textContent).toBe("Needs the repo scope.");
    const connect = within(card).getByTestId("connect") as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "bad" } });
    expect(connect.disabled).toBe(false);
    fireEvent.click(connect);
    expect((await within(card).findByRole("alert")).textContent).toBe("GitHub 401: Bad credentials");
    expect((within(card).getByTestId("token-input") as HTMLInputElement).value).toBe("bad");
    expect(input.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(input, { target: { value: "ghp_good_abcd" } });
    fireEvent.click(connect);
    expect((await within(card).findByText(/Connected as/)).textContent).toBe("Connected as octo");
    expect(within(card).getByTestId("forge-meta").textContent).toContain("token ends ••••abcd");
  });

  it("sends the GitLab base URL, defaulting to gitlab.com", async () => {
    const fetchMock = fakeApi();
    renderPage();
    const card = screen.getByTestId("forge-gitlab");
    const base = (await within(card).findByTestId("base-url-input")) as HTMLInputElement;
    expect(base.placeholder).toBe("https://gitlab.com");
    expect(within(card).getByText(/scope\./).textContent).toBe("Needs the api scope.");
    expect(within(card).getByText(/self-hosted GitLab/).textContent).toBe("Default https://gitlab.com; change it for self-hosted GitLab.");
    fireEvent.change(base, { target: { value: "https://gitlab.example.com" } });
    fireEvent.change(within(card).getByTestId("token-input"), { target: { value: "gl-good" } });
    fireEvent.click(within(card).getByTestId("connect"));
    expect((await within(card).findByText(/Connected as/)).textContent).toBe("Connected as gitlab-user");
    expect(within(card).getByTestId("forge-meta").textContent).toBe("https://gitlab.example.com · token ends ••••wxyz");
    expect(calls(fetchMock, "PUT", "/api/forges/gitlab")[0]?.[1]?.body).toBe(JSON.stringify({ token: "gl-good", baseUrl: "https://gitlab.example.com" }));
  });

  it("defaults an empty GitLab base URL to https://gitlab.com", async () => {
    const fetchMock = fakeApi();
    renderPage();
    const card = screen.getByTestId("forge-gitlab");
    fireEvent.change(await within(card).findByTestId("token-input"), { target: { value: "gl-good" } });
    fireEvent.click(within(card).getByTestId("connect"));
    await within(card).findByText(/Connected as/);
    expect(calls(fetchMock, "PUT", "/api/forges/gitlab")[0]?.[1]?.body).toBe(JSON.stringify({ token: "gl-good", baseUrl: "https://gitlab.com" }));
  });

  it("sets data-theme and saves the choice from the Appearance control", async () => {
    fakeApi();
    renderPage();
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    expect(within(group).getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(group).getByRole("radio", { name: "Light" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(window.localStorage.getItem(THEME_KEY)).toBe("light");
    expect(within(group).getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(group).getByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
  });

  it("shows the sandbox card as available with the default image and the limits", async () => {
    fakeApi({}, {});
    renderPage();
    const card = screen.getByTestId("sandbox-card");
    expect((await within(card).findByTestId("sandbox-status")).textContent).toBe("available");
    expect(within(card).getByTestId("sandbox-default-image").textContent).toBe("ghcr.io/acme/graph-manager:1.2.3");
    expect(within(card).queryByTestId("sandbox-reason")).toBeNull();
    await waitFor(() => expect((within(card).getByTestId("sandbox-cpus") as HTMLInputElement).value).toBe("2"));
    expect((within(card).getByTestId("sandbox-memory") as HTMLInputElement).value).toBe("4096");
    expect((within(card).getByTestId("sandbox-pids") as HTMLInputElement).value).toBe("2048");
    expect((within(card).getByTestId("sandbox-save") as HTMLButtonElement).disabled).toBe(true);
    expect(within(card).getByText("Applies to sandboxed runs started after saving.")).toBeTruthy();
  });

  it("shows not available with the reason", async () => {
    const reason = "Docker is not reachable at /var/run/docker.sock: connect ENOENT";
    fakeApi({}, { status: { available: false, reason } });
    renderPage();
    const card = screen.getByTestId("sandbox-card");
    expect((await within(card).findByTestId("sandbox-status")).textContent).toBe("not available");
    expect(within(card).getByTestId("sandbox-reason").textContent).toBe(reason);
    expect(within(card).getByTestId("sandbox-default-image").textContent).toBe("none: the image is not built yet (fix the recipe or press Rebuild), or set a workspace image");
  });

  it("shows an unknown status and disabled fields when the API fails", async () => {
    fakeApi();
    renderPage();
    const card = screen.getByTestId("sandbox-card");
    expect((await within(card).findByTestId("sandbox-status")).textContent).toBe("unknown");
    expect((await within(card).findByTestId("sandbox-load-error")).textContent).toContain("Couldn't load the sandbox limits");
    expect((within(card).getByTestId("sandbox-memory") as HTMLInputElement).disabled).toBe(true);
  });

  it("saves changed limits with PUT and toasts", async () => {
    const fetchMock = fakeApi({}, {});
    renderPage();
    const card = screen.getByTestId("sandbox-card");
    const memory = within(card).getByTestId("sandbox-memory") as HTMLInputElement;
    await waitFor(() => expect(memory.value).toBe("4096"));
    fireEvent.change(memory, { target: { value: "8192" } });
    const save = within(card).getByTestId("sandbox-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(await screen.findByText("Saved sandbox limits")).toBeTruthy();
    expect(calls(fetchMock, "PUT", "/api/settings/sandbox")[0]?.[1]?.body).toBe(JSON.stringify({ cpus: 2, memoryMb: 8192, pids: 2048 }));
    await waitFor(() => expect(save.disabled).toBe(true));
  });

  it("shows a 400 under the sandbox form", async () => {
    fakeApi({}, { putError: "memoryMb: Number must be less than or equal to 1048576" });
    renderPage();
    const card = screen.getByTestId("sandbox-card");
    const memory = within(card).getByTestId("sandbox-memory") as HTMLInputElement;
    await waitFor(() => expect(memory.value).toBe("4096"));
    fireEvent.change(memory, { target: { value: "2097152" } });
    fireEvent.click(within(card).getByTestId("sandbox-save"));
    expect((await within(card).findByRole("alert")).textContent).toBe("memoryMb: Number must be less than or equal to 1048576");
  });
});
