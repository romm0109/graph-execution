// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiToken } from "../types";
import { ToastProvider } from "../ui/toast";
import { TokensCard } from "./TokensCard";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const NEW_TOKEN = "gmt_" + "A".repeat(43);

function fakeApi(initial: ApiToken[] = [], opts: { listStatus?: number } = {}) {
  let tokens = [...initial];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/tokens" && method === "GET") {
      if (opts.listStatus) return json({ error: "boom" }, opts.listStatus);
      return json({ tokens });
    }
    if (url === "/api/tokens" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { name: string; scopes: string[] };
      const t: ApiToken = { id: "new1", name: body.name, scopes: body.scopes, createdAt: new Date().toISOString(), createdBy: "admin" };
      tokens = [t, ...tokens];
      return json({ ...t, token: NEW_TOKEN }, 201);
    }
    const m = /^\/api\/tokens\/(.+)$/.exec(url);
    if (m && method === "DELETE") {
      tokens = tokens.filter((t) => t.id !== m[1]);
      return new Response(null, { status: 204 });
    }
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const renderCard = () =>
  render(
    <ToastProvider>
      <TokensCard />
    </ToastProvider>,
  );

const existing: ApiToken = { id: "abc", name: "ci-bot", scopes: ["runs:read", "runs:start"], createdAt: new Date().toISOString(), createdBy: "admin" };

describe("TokensCard", () => {
  it("lists a token with its name, scopes and 'never'", async () => {
    fakeApi([existing]);
    renderCard();
    const row = await screen.findByTestId("token-row-abc");
    expect(within(row).getByText("ci-bot")).toBeTruthy();
    expect(within(row).getByText("runs:read, runs:start")).toBeTruthy();
    expect(within(row).getByText("never")).toBeTruthy();
  });

  it("shows 'No tokens yet.' for an empty list", async () => {
    fakeApi([]);
    renderCard();
    expect((await screen.findByTestId("tokens-empty")).textContent).toBe("No tokens yet.");
  });

  it("disables Create token until a name and a scope are given", async () => {
    fakeApi([]);
    renderCard();
    const btn = screen.getByTestId("token-create") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("token-name"), { target: { value: "bot" } });
    expect(btn.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("token-scope-runs:read"));
    expect(btn.disabled).toBe(false);
    fireEvent.click(screen.getByTestId("token-scope-runs:read"));
    expect(btn.disabled).toBe(true);
  });

  it("creates a token, shows it once with Copy, and forgets it on Done", async () => {
    const fetchMock = fakeApi([]);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderCard();
    expect(screen.getAllByRole("checkbox")).toHaveLength(6);
    fireEvent.change(screen.getByTestId("token-name"), { target: { value: "bot" } });
    fireEvent.click(screen.getByTestId("token-scope-runs:read"));
    fireEvent.click(screen.getByTestId("token-create"));

    const box = await screen.findByTestId("token-created");
    const postCall = fetchMock.mock.calls.find(([u, init]) => u === "/api/tokens" && init?.method === "POST");
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({ name: "bot", scopes: ["runs:read"] });
    expect((within(box).getByTestId("token-value") as HTMLInputElement).value).toBe(NEW_TOKEN);
    expect(within(box).getByText("Copy it now. You won't see it again.")).toBeTruthy();
    expect((screen.getByTestId("token-name") as HTMLInputElement).value).toBe("");
    expect(await screen.findByTestId("token-row-new1")).toBeTruthy();

    fireEvent.click(screen.getByTestId("token-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(NEW_TOKEN));
    expect(await screen.findByText("Copied")).toBeTruthy();

    fireEvent.click(screen.getByTestId("token-done"));
    expect(screen.queryByTestId("token-created")).toBeNull();
    expect(document.body.innerHTML).not.toContain(NEW_TOKEN);
  });

  it("revokes a token after confirmation", async () => {
    const fetchMock = fakeApi([existing]);
    renderCard();
    const row = await screen.findByTestId("token-row-abc");
    fireEvent.click(within(row).getByTestId("token-revoke"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Revoke ci-bot?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.queryByTestId("token-row-abc")).toBeNull());
    expect(fetchMock.mock.calls.some(([u, init]) => u === "/api/tokens/abc" && init?.method === "DELETE")).toBe(true);
  });

  it.each([404, 500])("shows a load error when GET /api/tokens answers %i, and keeps the form", async (status) => {
    fakeApi([], { listStatus: status });
    renderCard();
    expect((await screen.findByTestId("tokens-load-error")).textContent).toMatch(/^Couldn't load the API tokens/);
    expect(screen.getByTestId("token-create")).toBeTruthy();
  });
});
