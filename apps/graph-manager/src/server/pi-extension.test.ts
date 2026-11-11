// The pi extension that graph-manager writes (writePiExtension), loaded the way pi loads it (a TypeScript module with
// a default export taking pi's API), against graph-manager's real MCP server (src/server/mcp.ts) and a listening
// graph-manager. Node runs both from source with --experimental-strip-types.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { writePiExtension } from "./agents.js";
import { buildApp } from "./app.js";
import { cookieOf, tempDir, testConfig } from "./test-helpers.js";
import { TOOLS } from "./tools/index.js";
import { defineTool } from "./tools/types.js";

const MCP_TS = fileURLToPath(new URL("./mcp.ts", import.meta.url));
const TOKEN = "t0ken";
const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
const canStripTypes = major > 22 || (major === 22 && minor >= 6);

const echoTool = defineTool({
  name: "echo_ws",
  description: "test",
  input: z.object({ say: z.string() }),
  run: async (i, tc) => ({ text: `${i.say}:${tc.workspace?.id ?? "none"}:${tc.terminal.id}` }),
});

// Plays pi: loads the extension, collects the tools it registers, runs a few and prints what came back.
const HARNESS = `
const ext = await import(process.argv[2]);
const tools = [];
await ext.default({ registerTool: (t) => tools.push(t) });
const byName = (n) => tools.find((t) => t.name === n);
const echo = await byName("graph-manager_echo_ws").execute("c1", { say: "hi" }, undefined, undefined, {});
const bad = await byName("graph-manager_open_start_run").execute("c2", { tasksDir: "nope", spec: "nope.md" }, undefined, undefined, {});
console.log(JSON.stringify({ tools: tools.map((t) => ({ name: t.name, label: t.label, parameters: t.parameters })), echo, bad }));
process.exit(0);
`;

let app: FastifyInstance;
let cleanup: () => Promise<void>;
let dir: string;
let dataDir: string;
let port: number;
let terminalId: string;
let wsDir: string;

beforeEach(async () => {
  const t = await tempDir();
  cleanup = t.cleanup;
  dir = t.dir;
  const config = testConfig(t.dir);
  dataDir = config.dataDir;
  wsDir = path.join(config.workspacesDir, "github", "octo", "hello");
  await mkdir(path.join(wsDir, ".git"), { recursive: true });
  app = await buildApp(config, { webDir: path.join(t.dir, "no-web"), viewCache: false, internalToken: TOKEN, tools: [...TOOLS, echoTool] });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: config.password } });
  const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie: cookieOf(login) }, payload: { workspaceId: "github~octo~hello" } });
  terminalId = (res.json() as { id: string }).id;
});

afterEach(async () => {
  await app.close();
  await cleanup();
});

describe("pi extension", () => {
  it("is written at startup as a module with only node: imports", async () => {
    const file = path.join(dataDir, "agents", "pi-graph-manager.ts");
    expect(writePiExtension(dataDir)).toBe(file);
    const source = await readFile(file, "utf8");
    expect(source.startsWith("// graph-manager's tools in pi.")).toBe(true);
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const m of imports) expect(m).toMatch(/^node:/);
    expect(source.split("\n").length).toBeLessThan(140);
  });

  it.skipIf(!canStripTypes || process.platform === "win32")("lists graph-manager's tools and calls them through graph-manager-mcp", async () => {
    // graph-manager-mcp on the PATH, as in a terminal: the MCP server from source.
    const bin = path.join(dir, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      path.join(bin, "graph-manager-mcp"),
      `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types --no-warnings "${MCP_TS}" "$@"\n`,
      { mode: 0o755 },
    );
    const harness = path.join(dir, "harness.mjs");
    await writeFile(harness, HARNESS);
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      GM_INTERNAL_URL: `http://127.0.0.1:${port}`,
      GM_INTERNAL_TOKEN: TOKEN,
      GM_TERMINAL_ID: terminalId,
    };
    const ext = pathToFileURL(path.join(dataDir, "agents", "pi-graph-manager.ts")).href;
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ["--experimental-strip-types", "--no-warnings", harness, ext], { env, cwd: wsDir, timeout: 20_000 }, (err, out, errOut) =>
        err ? reject(new Error(`${err.message}\n${errOut}`)) : resolve(out),
      );
    });
    const got = JSON.parse(stdout.trim().split("\n").pop()!) as {
      tools: { name: string; label: string; parameters: { type?: string; properties?: Record<string, unknown> } }[];
      echo: unknown;
      bad: { content: { text: string }[] };
    };
    const names = got.tools.map((t) => t.name);
    expect(names).toContain("graph-manager_open_start_run");
    expect(names).toContain("graph-manager_echo_ws");
    const start = got.tools.find((t) => t.name === "graph-manager_open_start_run")!;
    expect(start.parameters.type).toBe("object");
    expect(Object.keys(start.parameters.properties ?? {})).toEqual(expect.arrayContaining(["tasksDir", "spec"]));
    expect(got.echo).toEqual({ content: [{ type: "text", text: `hi:github~octo~hello:${terminalId}` }], details: {} });
    expect(got.bad.content[0]!.text).toBe("Error: tasks folder nope is not a folder inside the workspace");
  });
});
