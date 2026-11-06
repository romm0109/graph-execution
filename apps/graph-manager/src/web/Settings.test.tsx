// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Settings from "./pages/Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeApi() {
  const state = { github: { connected: false } as Record<string, unknown>, gitlab: { connected: false } as Record<string, unknown> };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/forges" && method === "GET") return json(state);
    if (url === "/api/forges/github" && method === "PUT") {
      const { token } = JSON.parse(String(init?.body)) as { token: string };
      if (token !== "gh-good") return json({ error: "GitHub 401: Bad credentials" }, 400);
      state.github = { connected: true, login: "octo" };
      return json(state.github);
    }
    if (url === "/api/forges/gitlab" && method === "PUT") {
      const { baseUrl } = JSON.parse(String(init?.body)) as { baseUrl: string };
      state.gitlab = { connected: true, login: "gitlab-user", baseUrl };
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

describe("Settings", () => {
  it("shows the forge error, then connects and disconnects GitHub", async () => {
    fakeApi();
    render(<Settings />);
    const card = await screen.findByTestId("forge-github");
    const input = await within(card).findByTestId("token-input");
    fireEvent.change(input, { target: { value: "bad" } });
    fireEvent.click(within(card).getByTestId("connect"));
    expect((await within(card).findByRole("alert")).textContent).toBe("GitHub 401: Bad credentials");

    fireEvent.change(within(card).getByTestId("token-input"), { target: { value: "gh-good" } });
    fireEvent.click(within(card).getByTestId("connect"));
    expect((await within(card).findByText(/Connected as/)).textContent).toContain("octo");

    fireEvent.click(within(card).getByTestId("disconnect"));
    expect(await within(card).findByTestId("token-input")).toBeTruthy();
  });

  it("connects GitLab with the default base URL", async () => {
    const fetchMock = fakeApi();
    render(<Settings />);
    const card = await screen.findByTestId("forge-gitlab");
    fireEvent.change(await within(card).findByTestId("token-input"), { target: { value: "gl-good" } });
    fireEvent.click(within(card).getByTestId("connect"));
    expect((await within(card).findByText(/Connected as/)).textContent).toContain("https://gitlab.com");
    expect(fetchMock).toHaveBeenCalledWith("/api/forges/gitlab", expect.objectContaining({ method: "PUT", body: JSON.stringify({ token: "gl-good", baseUrl: "https://gitlab.com" }) }));
  });
});
