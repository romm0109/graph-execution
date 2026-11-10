import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toolApp, writeRun, type ToolApp } from "./tool-test-helpers.js";

let t: ToolApp;
const ID = "gm-20261106-100000-aaaa";

beforeEach(async () => {
  t = await toolApp();
});
afterEach(async () => {
  await t.cleanup();
});

describe.skipIf(process.platform === "win32")("get_run_log", () => {
  it("returns exactly the last N lines", async () => {
    const dir = await writeRun(t.wsDir, ID);
    await writeFile(path.join(dir, "run.log"), Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\n");
    const r = await t.call("get_run_log", { runId: ID, lines: 5 });
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe(`run.log of ${ID} (last 5 lines)\n\n\`\`\`\nline6\nline7\nline8\nline9\nline10\n\`\`\``);
    const all = await t.call("get_run_log", { runId: ID });
    expect(all.text.split("\n")[0]).toBe(`run.log of ${ID} (all 10 lines)`);
  });

  it("uses a longer fence when the log holds backticks", async () => {
    const dir = await writeRun(t.wsDir, ID);
    await writeFile(path.join(dir, "run.log"), "a\n```\nb\n");
    const r = await t.call("get_run_log", { runId: ID });
    expect(r.text).toContain("````\na\n```\nb\n````");
  });

  it("says when there is no run.log", async () => {
    await writeRun(t.wsDir, ID);
    expect(await t.call("get_run_log", { runId: ID })).toEqual({ isError: true, text: `run ${ID} has no run.log yet` });
  });

  it("refuses unknown and invalid run ids", async () => {
    expect(await t.call("get_run_log", { runId: "nope-run" })).toEqual({ isError: true, text: "unknown run nope-run" });
    expect(await t.call("get_run_log", { runId: "../x" })).toEqual({ isError: true, text: "unknown run ../x" });
  });

  it("refuses a terminal outside every workspace", async () => {
    expect(await t.call("get_run_log", { runId: ID }, { terminalId: t.rootTerminalId, cwd: t.config.workspacesDir })).toEqual({
      isError: true,
      text: "this terminal is not inside a graph-manager workspace",
    });
  });
});
