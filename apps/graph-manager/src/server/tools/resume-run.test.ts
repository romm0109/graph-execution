import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../app.js";
import { RunOrigins } from "../run-origins.js";
import type { TerminalInfo } from "../terminals.js";
import { tempDir, testConfig } from "../test-helpers.js";
import { resolveWorkspace } from "../workspaces.js";
import { resumeRunTool } from "./resume-run.js";
import { toolApp, writeRun, type ToolApp } from "./tool-test-helpers.js";

const RUN = "gm-20261108-100000-aaaa";
const WS = "github~octo~hello";
const FAKE_BIN = `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./argv.json", import.meta.url), JSON.stringify(process.argv.slice(2)));
`;
const FAILING_BIN = `console.log("boom"); process.exit(1);\n`;

let bin: { dir: string; cleanup: () => Promise<void> };
let fakeBin: string;
let failingBin: string;
let argvFile: string;
let t: ToolApp | undefined;

beforeEach(async () => {
  bin = await tempDir();
  fakeBin = path.join(bin.dir, "fake-ge.mjs");
  failingBin = path.join(bin.dir, "failing-ge.mjs");
  argvFile = path.join(bin.dir, "argv.json");
  await writeFile(fakeBin, FAKE_BIN);
  await writeFile(failingBin, FAILING_BIN);
});
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
  await bin.cleanup();
});

describe.skipIf(process.platform === "win32")("resume_run", () => {
  it("resumes an aborted run", async () => {
    t = await toolApp({ graphExecutionBin: fakeBin });
    await writeRun(t.wsDir, RUN, { status: "aborted" });
    expect(await t.call("resume_run", { runId: RUN })).toEqual({ text: `Resumed run ${RUN}. You'll get its events in this terminal.` });
    expect(JSON.parse(await readFile(argvFile, "utf8"))).toEqual(expect.arrayContaining(["--resume", "--run", RUN, "--web"]));
  });

  it("closes the page an aborted run keeps open, then resumes it (P3)", async () => {
    t = await toolApp({ graphExecutionBin: fakeBin });
    const runDir = await writeRun(t.wsDir, RUN, { status: "aborted" });
    const hits: string[] = [];
    const page = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.method === "POST" && req.url === "/close") {
        // Like the engine: the page process goes away.
        void writeFile(path.join(runDir, "web.json"), JSON.stringify({ url: "http://127.0.0.1:1/", pid: 2 ** 22 + 12345 })).then(() =>
          res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = page.address() as AddressInfo;
      await writeFile(path.join(runDir, "web.json"), JSON.stringify({ url: `http://127.0.0.1:${port}/`, pid: process.pid }));
      expect(await t.call("resume_run", { runId: RUN })).toEqual({ text: `Resumed run ${RUN}. You'll get its events in this terminal.` });
      expect(hits).toEqual(["POST /close"]);
      expect(JSON.parse(await readFile(argvFile, "utf8"))).toEqual(expect.arrayContaining(["--resume", "--run", RUN]));
    } finally {
      page.closeAllConnections();
      await new Promise<void>((resolve) => page.close(() => resolve()));
    }
  });

  it("leaves a run that is still working alone", async () => {
    t = await toolApp({ graphExecutionBin: fakeBin });
    const runDir = await writeRun(t.wsDir, RUN, { status: "running", tasks: { "1": { status: "running", attempts: 1 } } });
    await writeFile(path.join(runDir, "web.json"), JSON.stringify({ url: "http://127.0.0.1:9/", pid: process.pid }));
    expect(await t.call("resume_run", { runId: RUN })).toEqual({ isError: true, text: "the run is live" });
    expect(existsSync(argvFile)).toBe(false);
  });

  it("refuses a finished run", async () => {
    t = await toolApp({ graphExecutionBin: fakeBin });
    await writeRun(t.wsDir, RUN, { status: "applied" });
    expect(await t.call("resume_run", { runId: RUN })).toEqual({ isError: true, text: "the run already finished (applied)" });
    expect(existsSync(argvFile)).toBe(false);
  });

  it("refuses an unknown run and a terminal outside workspaces", async () => {
    t = await toolApp({ graphExecutionBin: fakeBin });
    expect(await t.call("resume_run", { runId: "gm-20261108-100000-zzzz" })).toEqual({ isError: true, text: "unknown run gm-20261108-100000-zzzz" });
    expect(await t.call("resume_run", { runId: RUN }, { terminalId: t.rootTerminalId, cwd: t.config.workspacesDir })).toEqual({
      isError: true,
      text: "this terminal is not inside a graph-manager workspace",
    });
  });

  it("returns a failed engine start as a tool error with its output", async () => {
    t = await toolApp({ graphExecutionBin: failingBin });
    await writeRun(t.wsDir, RUN, { status: "failed" });
    const r = await t.call("resume_run", { runId: RUN });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("boom");
    expect(r.text.match(/boom/g)).toHaveLength(1);
  });

  it("makes the calling terminal the run's origin, only on success", async () => {
    const d = await tempDir();
    try {
      const config = testConfig(d.dir, { graphExecutionBin: fakeBin });
      const wsDir = path.join(config.workspacesDir, "github", "octo", "hello");
      await mkdir(path.join(wsDir, ".git"), { recursive: true });
      await writeRun(wsDir, RUN, { status: "aborted" });
      const applied = "gm-20261108-100000-bbbb";
      await writeRun(wsDir, applied, { status: "applied" });
      const ctx = { config, runOrigins: new RunOrigins(), sandboxes: undefined } as unknown as AppContext;
      const tc = {
        ctx,
        terminal: { id: "t9", title: "t", cwd: wsDir, status: "idle", createdAt: "x" } as unknown as TerminalInfo,
        workspace: resolveWorkspace(config.workspacesDir, WS)!,
        cwd: wsDir,
      };
      expect(await resumeRunTool.run({ runId: RUN }, tc)).toEqual({ text: `Resumed run ${RUN}. You'll get its events in this terminal.` });
      expect(ctx.runOrigins.get(WS, RUN)).toBe("t9");
      expect(await resumeRunTool.run({ runId: applied }, tc)).toEqual({ isError: true, text: "the run already finished (applied)" });
      expect(ctx.runOrigins.get(WS, applied)).toBeUndefined();
    } finally {
      await d.cleanup();
    }
  });
});
