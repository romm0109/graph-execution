import { describe, expect, it, vi } from "vitest";
import { handleMessage, type McpEnv } from "./mcp.js";

const ENV: McpEnv = { GM_INTERNAL_URL: "http://127.0.0.1:9/", GM_INTERNAL_TOKEN: "tok", GM_TERMINAL_ID: "t3" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const TOOL = { name: "echo_ws", description: "test", inputSchema: { type: "object" } };

describe("handleMessage", () => {
  it("answers initialize with the client's protocol version", async () => {
    const f = vi.fn<typeof fetch>();
    const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, ENV, "/w", f);
    expect(res).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "graph-manager", version: "0.1.0" } },
    });
    const dflt = await handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize" }, ENV, "/w", f);
    expect((dflt?.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
    expect(f).not.toHaveBeenCalled();
  });

  it("ignores notifications and answers ping", async () => {
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, ENV, "/w", vi.fn())).toBeUndefined();
    expect(await handleMessage({ jsonrpc: "2.0", id: "p", method: "ping" }, ENV, "/w", vi.fn())).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
  });

  it("lists the tools with the bearer token", async () => {
    const f = vi.fn<typeof fetch>(async () => json({ tools: [TOOL] }));
    const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ENV, "/w", f);
    expect(res?.result).toEqual({ tools: [TOOL] });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:9/api/internal/tools");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("lists no tools outside a graph-manager terminal or when the server fails", async () => {
    const f = vi.fn<typeof fetch>();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect((await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {}, "/w", f))?.result).toEqual({ tools: [] });
      expect(f).not.toHaveBeenCalled();
      const failing = vi.fn<typeof fetch>(async () => json({ error: "bad internal token" }, 401));
      expect((await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ENV, "/w", failing))?.result).toEqual({ tools: [] });
      const throwing = vi.fn<typeof fetch>(async () => {
        throw new TypeError("fetch failed");
      });
      expect((await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ENV, "/w", throwing))?.result).toEqual({ tools: [] });
    } finally {
      stderr.mockRestore();
    }
  });

  it("calls a tool with the terminal, cwd and arguments", async () => {
    const f = vi.fn<typeof fetch>(async () => json({ text: "done" }));
    const res = await handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo ws", arguments: { say: "hi" } } }, ENV, "/w/x", f);
    expect(res).toEqual({ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "done" }], isError: false } });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:9/api/internal/tools/echo%20ws");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ terminalId: "t3", cwd: "/w/x", input: { say: "hi" } });
    const err = await handleMessage(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "x" } },
      ENV,
      "/w",
      vi.fn<typeof fetch>(async () => json({ text: "nope", isError: true })),
    );
    expect(err?.result).toEqual({ content: [{ type: "text", text: "nope" }], isError: true });
  });

  it("turns missing env, HTTP and network errors into error results", async () => {
    const call = (env: McpEnv, f: typeof fetch) => handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } }, env, "/w", f);
    const none = vi.fn<typeof fetch>();
    expect((await call({ GM_INTERNAL_URL: "http://x" }, none))?.result).toEqual({
      content: [{ type: "text", text: "graph-manager tools work only in a graph-manager terminal" }],
      isError: true,
    });
    expect(none).not.toHaveBeenCalled();
    expect((await call(ENV, vi.fn<typeof fetch>(async () => json({ error: "unknown tool nope" }, 404))))?.result).toEqual({
      content: [{ type: "text", text: "unknown tool nope" }],
      isError: true,
    });
    expect((await call(ENV, vi.fn<typeof fetch>(async () => new Response("oops", { status: 500 }))))?.result).toMatchObject({
      content: [{ type: "text", text: "graph-manager answered 500" }],
    });
    const throwing = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
    });
    const r = (await call(ENV, throwing))?.result as { content: { text: string }[]; isError: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("graph-manager did not answer at http://127.0.0.1:9: ECONNREFUSED");
  });

  it("answers an unknown method with -32601", async () => {
    expect(await handleMessage({ jsonrpc: "2.0", id: 9, method: "resources/list" }, ENV, "/w", vi.fn())).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32601, message: "method not found: resources/list" },
    });
  });
});
