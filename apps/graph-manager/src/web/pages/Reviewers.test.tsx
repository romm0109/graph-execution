// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Reviewer } from "../reviewers";
import { ToastProvider } from "../ui/toast";
import Reviewers, { REVIEWERS_NOTE } from "./Reviewers";

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const CODE: Reviewer = {
  id: "code",
  type: "diff",
  name: "Code review",
  enabled: true,
  instructions: "built-in code",
  repoFile: "REVIEW.md",
  blockAt: "major",
};
const TESTER: Reviewer = {
  id: "tester",
  type: "tester",
  name: "Tester",
  enabled: true,
  instructions: "built-in tester",
  repoFile: "TESTER.md",
  blockAt: "major",
};

function fakeApi(extra: Reviewer[] = []) {
  let reviewers: Reviewer[] = [{ ...CODE, instructions: "edited" }, TESTER, ...extra];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Reviewer) : undefined;
    if (url === "/api/reviewers" && method === "GET")
      return json({
        reviewers,
        builtinIds: ["code", "tester"],
        providers: ["claude", "codex", "opencode", "qwen", "fake"],
        file: "/data/reviewers.json",
      });
    if (url === "/api/reviewers" && method === "POST") {
      if (body!.repoFile === "REVIEW.md") return json({ error: 'repoFile: "REVIEW.md" is already used by reviewer "code"' }, 400);
      reviewers = [...reviewers, body!];
      return json({ reviewer: body }, 201);
    }
    const m = /^\/api\/reviewers\/(?:reset\/)?([^/]+)$/.exec(url);
    if (m && url.includes("/reset/") && method === "POST") {
      const builtin = m[1] === "code" ? CODE : TESTER;
      reviewers = reviewers.map((r) => (r.id === builtin.id ? { ...r, instructions: builtin.instructions } : r));
      return json({ reviewer: reviewers.find((r) => r.id === builtin.id) });
    }
    if (m && method === "PUT") {
      reviewers = reviewers.map((r) => (r.id === m[1] ? body! : r));
      return json({ reviewer: body });
    }
    if (m && method === "DELETE") {
      reviewers = reviewers.filter((r) => r.id !== m[1]);
      return new Response(null, { status: 204 });
    }
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const renderPage = () =>
  render(
    <ToastProvider>
      <Reviewers />
    </ToastProvider>,
  );

const calls = (fetchMock: ReturnType<typeof fakeApi>, method: string, url: string) =>
  fetchMock.mock.calls.filter(([u, init]) => u === url && (init?.method ?? "GET") === method);

const SECURITY: Reviewer = {
  id: "security",
  type: "diff",
  name: "Security",
  enabled: true,
  instructions: "",
  repoFile: "SECURITY_REVIEW.md",
  blockAt: "major",
};

describe("Reviewers page", () => {
  it("shows the note and a row per reviewer; tester has no Delete", async () => {
    fakeApi();
    renderPage();
    expect(screen.getByText(REVIEWERS_NOTE)).toBeTruthy();
    expect(REVIEWERS_NOTE).toBe("Used by every run started from graph-manager. Runs already going keep the reviewers they started with.");
    const code = await screen.findByTestId("reviewer-row-code");
    expect(code.textContent).toContain("Code review");
    expect(code.textContent).toContain("diff");
    expect(code.textContent).toContain("run default");
    expect(code.textContent).toContain("blocks at major");
    expect(screen.getByTestId("reviewer-delete-code")).toBeTruthy();
    expect(screen.getByTestId("reviewer-row-tester").textContent).toContain("live tester");
    expect(screen.queryByTestId("reviewer-delete-tester")).toBeNull();
    expect(screen.getByText("/data/reviewers.json")).toBeTruthy();
  });

  it("adds a reviewer with the id and repo file derived from the name", async () => {
    const fetchMock = fakeApi();
    renderPage();
    await screen.findByTestId("reviewer-row-code");
    fireEvent.click(screen.getByTestId("reviewer-add"));
    const drawer = screen.getByTestId("reviewer-drawer");
    fireEvent.change(within(drawer).getByLabelText("Name"), {
      target: { value: "Security" },
    });
    expect((within(drawer).getByLabelText("Id") as HTMLInputElement).value).toBe("security");
    expect((within(drawer).getByLabelText("Repo file") as HTMLInputElement).value).toBe("SECURITY_REVIEW.md");
    expect(drawer.textContent).toContain("Optional file at the repo root with this repo's own rules for this reviewer");
    fireEvent.click(screen.getByTestId("reviewer-save"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/reviewers")).toHaveLength(1));
    const sent = JSON.parse(String(calls(fetchMock, "POST", "/api/reviewers")[0]![1]!.body)) as Reviewer;
    expect(sent).toMatchObject({
      id: "security",
      name: "Security",
      type: "diff",
      repoFile: "SECURITY_REVIEW.md",
      blockAt: "major",
    });
    expect(await screen.findByTestId("reviewer-row-security")).toBeTruthy();
    expect(screen.queryByTestId("reviewer-drawer")).toBeNull();
    expect(screen.getByTestId("toasts").textContent).toContain("Added Security");
  });

  it("keeps the drawer open and shows a server validation error", async () => {
    fakeApi();
    renderPage();
    await screen.findByTestId("reviewer-row-code");
    fireEvent.click(screen.getByTestId("reviewer-add"));
    const drawer = screen.getByTestId("reviewer-drawer");
    fireEvent.change(within(drawer).getByLabelText("Name"), {
      target: { value: "Dup" },
    });
    fireEvent.change(within(drawer).getByLabelText("Repo file"), {
      target: { value: "REVIEW.md" },
    });
    fireEvent.keyDown(within(drawer).getByLabelText("Name"), {
      key: "Enter",
      ctrlKey: true,
    });
    expect((await screen.findByTestId("reviewer-error")).textContent).toBe('repoFile: "REVIEW.md" is already used by reviewer "code"');
    expect(screen.getByTestId("reviewer-drawer")).toBeTruthy();
  });

  it("toggles a reviewer with a PUT of the full reviewer", async () => {
    const fetchMock = fakeApi([SECURITY]);
    renderPage();
    const sw = (await screen.findByTestId("reviewer-enabled-security")) as HTMLInputElement;
    expect(sw.getAttribute("role")).toBe("switch");
    expect(sw.getAttribute("aria-label")).toBe("Enable Security");
    fireEvent.click(sw);
    await waitFor(() => expect(calls(fetchMock, "PUT", "/api/reviewers/security")).toHaveLength(1));
    expect(JSON.parse(String(calls(fetchMock, "PUT", "/api/reviewers/security")[0]![1]!.body))).toEqual({ ...SECURITY, enabled: false });
    await waitFor(() => expect((screen.getByTestId("reviewer-enabled-security") as HTMLInputElement).checked).toBe(false));
  });

  it("rolls the switch back with a toast when the PUT fails", async () => {
    const fetchMock = fakeApi([SECURITY]);
    renderPage();
    const sw = (await screen.findByTestId("reviewer-enabled-security")) as HTMLInputElement;
    const ok = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (init?.method === "PUT" ? json({ error: "boom" }, 500) : ok(url, init)));
    fireEvent.click(sw);
    await waitFor(() => expect(screen.getByTestId("toasts").textContent).toContain("boom"));
    expect((screen.getByTestId("reviewer-enabled-security") as HTMLInputElement).checked).toBe(true);
  });

  it("deletes a reviewer after the confirm", async () => {
    const fetchMock = fakeApi([SECURITY]);
    renderPage();
    fireEvent.click(await screen.findByTestId("reviewer-delete-security"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Delete Security?");
    expect(dialog.textContent).toContain("Runs started from now on won't run this reviewer.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls(fetchMock, "DELETE", "/api/reviewers/security")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId("reviewer-row-security")).toBeNull());
    expect(screen.getByTestId("toasts").textContent).toContain("Deleted Security");
  });

  it("edits with the id fixed and saves with a PUT", async () => {
    const fetchMock = fakeApi([SECURITY]);
    renderPage();
    fireEvent.click(await screen.findByTestId("reviewer-edit-security"));
    const drawer = screen.getByTestId("reviewer-drawer");
    expect((within(drawer).getByLabelText("Id") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId("reviewer-reset")).toBeNull();
    fireEvent.change(within(drawer).getByLabelText("Files"), {
      target: { value: "src/**\n!src/**/*.test.ts\n" },
    });
    fireEvent.change(within(drawer).getByLabelText("Provider"), {
      target: { value: "codex" },
    });
    fireEvent.click(within(drawer).getByRole("radio", { name: "never" }));
    fireEvent.click(screen.getByTestId("reviewer-save"));
    await waitFor(() => expect(calls(fetchMock, "PUT", "/api/reviewers/security")).toHaveLength(1));
    expect(JSON.parse(String(calls(fetchMock, "PUT", "/api/reviewers/security")[0]![1]!.body))).toEqual({
      ...SECURITY,
      provider: "codex",
      files: ["src/**", "!src/**/*.test.ts"],
      blockAt: "never",
    });
    await waitFor(() => expect(screen.getByTestId("reviewer-row-security").textContent).toContain("never blocks"));
    expect(screen.getByTestId("toasts").textContent).toContain("Saved Security");
  });

  it("resets code to its built-in instructions after a confirm", async () => {
    const fetchMock = fakeApi();
    renderPage();
    fireEvent.click(await screen.findByTestId("reviewer-edit-code"));
    expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe("edited");
    fireEvent.click(screen.getByTestId("reviewer-reset"));
    const dialog = screen.getAllByRole("dialog").find((d) => d.textContent?.includes("Reset Code review?"))!;
    expect(dialog.textContent).toContain("Its instructions go back to the built-in text.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/reviewers/reset/code")).toHaveLength(1));
    await waitFor(() => expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe("built-in code"));
    expect(screen.getByTestId("reviewer-drawer")).toBeTruthy();
  });
});
