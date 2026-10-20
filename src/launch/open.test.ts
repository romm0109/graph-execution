import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempRepo } from "../__fixtures__/repo.js";
import { openRun } from "./open.js";

let repo: string;
let out: string[];
let err: string[];
let opened: string[];

beforeEach(async () => {
  repo = await tempRepo();
  out = [];
  err = [];
  opened = [];
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function makeRun(id: string, web?: { url: string; pid: number } | string): Promise<void> {
  const dir = path.join(repo, ".graph-execution", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "state.json"), "{}");
  if (web !== undefined) await writeFile(path.join(dir, "web.json"), typeof web === "string" ? web : JSON.stringify(web));
}

const deadPid = (): number => {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid!;
};

const run = (runId?: string, env: NodeJS.ProcessEnv = {}) =>
  openRun({
    cwd: repo,
    runId,
    env,
    open: async (url) => (opened.push(url), true),
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });

describe("openRun", () => {
  it("opens the page of the latest run when its process is alive", async () => {
    await makeRun("a", { url: "http://127.0.0.1:1111/", pid: process.pid });
    await makeRun("b", { url: "http://127.0.0.1:2222/", pid: process.pid });
    expect(await run()).toBe(0);
    expect(opened).toEqual(["http://127.0.0.1:2222/"]);
    expect(out).toEqual(["Opened run b: http://127.0.0.1:2222/"]);
  });

  it("opens the run given by --run", async () => {
    await makeRun("a", { url: "http://127.0.0.1:1111/", pid: process.pid });
    await makeRun("b", { url: "http://127.0.0.1:2222/", pid: process.pid });
    expect(await run("a")).toBe(0);
    expect(opened).toEqual(["http://127.0.0.1:1111/"]);
  });

  it("exits 2 for a dead pid and leaves web.json alone", async () => {
    await makeRun("a", { url: "http://127.0.0.1:1111/", pid: deadPid() });
    expect(await run()).toBe(2);
    expect(opened).toEqual([]);
    expect(err).toEqual(["run a has no live page (it was closed or isn't running with --web)"]);
    expect((await import("node:fs")).existsSync(path.join(repo, ".graph-execution", "a", "web.json"))).toBe(true);
  });

  it("exits 2 when web.json is missing or invalid", async () => {
    await makeRun("a");
    expect(await run()).toBe(2);
    await makeRun("b", "not json");
    expect(await run("b")).toBe(2);
    expect(err).toHaveLength(2);
  });

  it("throws findRun's error when there is no run", async () => {
    await expect(run()).rejects.toThrow("no run found in");
    await expect(run("zzz")).rejects.toThrow("no run zzz found in");
  });

  it("prints the URL and the port-forwarding hint over SSH", async () => {
    await makeRun("a", { url: "http://127.0.0.1:1111/", pid: process.pid });
    expect(await run(undefined, { SSH_CONNECTION: "1 2 3 4" })).toBe(0);
    expect(opened).toEqual([]);
    expect(out[0]).toBe("Run a: http://127.0.0.1:1111/");
    expect(out[1]).toContain("ssh -L 1111:127.0.0.1:1111 ");
  });
});
