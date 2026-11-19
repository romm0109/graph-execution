// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { escalationApi, mountEscalation } from "./escalation.js";

const RECORD = { id: "E1", node: "2", status: "open", reason: "A or B?", evidence: "spec", questions: [{ id: "q1", question: "A or B?" }] };

/** Answers the escalation screen's requests; `advisor` is the answer to `POST escalations/E1/advisor`. */
function stubFetch(advisor: { status: number; body: unknown }) {
  const posts: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: { method?: string }) => {
    const body = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (init?.method === "POST") {
      posts.push(url);
      return body(advisor.status, advisor.body);
    }
    if (url === "escalations") return body(200, { escalations: [RECORD] });
    if (url.endsWith("/draft")) return body(200, { draft: null });
    return body(200, { tasks: [] });
  });
  return posts;
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function mount(terminal?: () => Promise<unknown>) {
  const tab = document.createElement("div");
  const footer = document.createElement("div");
  document.body.append(tab, footer);
  const mountTerminal = vi.fn(() => ({ destroy: vi.fn(), fit: vi.fn(), focus: vi.fn() }));
  const loader = terminal ?? (async () => ({ mountTerminal, Terminal: class {}, FitAddon: class {} }));
  const ctl = mountEscalation(tab, footer, { id: "E1", terminal: loader as never });
  const startButton = () => tab.querySelector<HTMLButtonElement>("#advisor-start, #advisor-restart")!;
  return { tab, ctl, mountTerminal, startButton };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("the advisor area", () => {
  it("starts the advisor and mounts the terminal on its WebSocket; the button becomes Restart", async () => {
    const posts = stubFetch({ status: 200, body: { running: true } });
    const { mountTerminal, startButton, tab } = mount();
    await flush();
    expect(startButton().textContent).toBe("Talk to an agent");
    startButton().click();
    await flush();
    expect(posts).toEqual(["escalations/E1/advisor"]);
    expect(mountTerminal).toHaveBeenCalledTimes(1);
    const opts = (mountTerminal.mock.calls[0] as unknown as [HTMLElement, { url: () => string; instantEcho: boolean }])[1];
    expect(opts.url()).toBe(escalationApi().advisorSocket("E1"));
    expect(opts.url()).toMatch(/^ws:\/\/.*\/escalations\/E1\/advisor\/terminal$/);
    expect(opts.instantEcho).toBe(true);
    expect(startButton().textContent).toBe("Restart");
    // The terminal's element survives the screen's re-renders.
    const host = tab.querySelector(".advisor-term");
    startButton().click();
    await flush();
    expect(posts).toEqual(["escalations/E1/advisor", "escalations/E1/advisor/restart"]);
    expect(mountTerminal).toHaveBeenCalledTimes(1);
    expect(tab.querySelector(".advisor-term")).toBe(host);
  });

  it("shows the unavailable message as it is, and the rest of the screen still works", async () => {
    const message = "The advisor terminal isn't available here (node-pty is missing). Write the draft by hand or use graph-execution resolve.";
    stubFetch({ status: 501, body: { error: { code: "unavailable", message } } });
    const { mountTerminal, startButton, tab } = mount();
    await flush();
    startButton().click();
    await flush();
    expect(tab.querySelector(".advisor-msg")!.textContent).toBe(message);
    expect(mountTerminal).not.toHaveBeenCalled();
    expect(startButton().textContent).toBe("Talk to an agent");
    expect(tab.textContent).toContain("No draft yet");
  });

  it("reattaches at once when the advisor already runs (a reload)", async () => {
    const posts = stubFetch({ status: 200, body: { running: true } });
    const { ctl, mountTerminal, startButton } = mount();
    await ctl.refresh({ open: ["E1"], advisor: "running" });
    await flush();
    expect(mountTerminal).toHaveBeenCalledTimes(1);
    expect(posts).toEqual([]);
    expect(startButton().textContent).toBe("Restart");
  });
});
