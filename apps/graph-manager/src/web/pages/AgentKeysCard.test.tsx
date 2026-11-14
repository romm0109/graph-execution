// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../ui/toast";
import { AgentKeysCard, providersLabel } from "./AgentKeysCard";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const NAMES: Record<string, string[]> = {
  ANTHROPIC_API_KEY: ["claude", "opencode"],
  CLAUDE_CODE_OAUTH_TOKEN: ["claude"],
  OPENAI_API_KEY: ["codex", "opencode", "qwen"],
};

function fakeApi(opts: { failLoad?: boolean; putError?: string } = {}) {
  const saved = new Set<string>();
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/settings/agent-keys" && method === "GET") {
      if (opts.failLoad) return json({ error: "boom" }, 500);
      return json({ keys: Object.entries(NAMES).map(([name, providers]) => ({ name, providers, saved: saved.has(name) })) });
    }
    const m = /^\/api\/settings\/agent-keys\/([A-Z_]+)$/.exec(url);
    if (m) {
      const name = m[1] ?? "";
      if (method === "PUT") {
        if (opts.putError) return json({ error: opts.putError }, 400);
        saved.add(name);
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE") {
        saved.delete(name);
        return new Response(null, { status: 204 });
      }
    }
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const renderCard = () =>
  render(
    <ToastProvider>
      <AgentKeysCard />
    </ToastProvider>,
  );

describe("Settings → Agents", () => {
  it("labels the providers of a key", () => {
    expect(providersLabel(["claude", "opencode"])).toBe("Used by Claude Code, OpenCode");
    expect(providersLabel(["codex", "qwen"])).toBe("Used by Codex, Qwen Code");
  });

  it("lists the keys, saves one, shows it saved and removes it after asking", async () => {
    const fetchMock = fakeApi();
    renderCard();
    const row = await screen.findByTestId("agent-key-ANTHROPIC_API_KEY");
    expect(within(row).getByText("Used by Claude Code, OpenCode")).toBeTruthy();
    expect(screen.getByTestId("agent-key-OPENAI_API_KEY").textContent).toContain("Used by Codex, OpenCode, Qwen Code");
    expect(within(row).queryByTestId("agent-key-saved")).toBeNull();

    const input = within(row).getByLabelText<HTMLInputElement>("ANTHROPIC_API_KEY");
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("off");
    fireEvent.change(input, { target: { value: "sk-test" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await within(row).findByTestId("agent-key-saved");
    expect(input.value).toBe("");
    expect(await screen.findByText("Saved ANTHROPIC_API_KEY")).toBeTruthy();
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(put?.[0]).toBe("/api/settings/agent-keys/ANTHROPIC_API_KEY");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ value: "sk-test" });

    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Remove ANTHROPIC_API_KEY?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(within(row).queryByTestId("agent-key-saved")).toBeNull());
    expect(await screen.findByText("Removed ANTHROPIC_API_KEY")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u, init]) => u === "/api/settings/agent-keys/ANTHROPIC_API_KEY" && init?.method === "DELETE")).toBe(true);
  });

  it("shows the server's error in the row", async () => {
    fakeApi({ putError: "value: too long" });
    renderCard();
    const row = await screen.findByTestId("agent-key-OPENAI_API_KEY");
    fireEvent.change(within(row).getByLabelText("OPENAI_API_KEY"), { target: { value: "x" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    expect((await within(row).findByRole("alert")).textContent).toBe("value: too long");
    expect(within(row).queryByTestId("agent-key-saved")).toBeNull();
  });

  it("says when the keys could not be loaded", async () => {
    fakeApi({ failLoad: true });
    renderCard();
    expect((await screen.findByTestId("agent-keys-error")).textContent).toBe("Couldn't load the agent keys.");
  });
});
