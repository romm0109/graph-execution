import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { tempRepo } from "./__fixtures__/repo.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "dist", "cli.js");
const fixtures = path.join(root, "src", "__fixtures__");
const args = [path.join(fixtures, "diamond"), "--spec", path.join(fixtures, "spec.md"), "--provider", "fake"];

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (fn: () => Promise<boolean> | boolean, ms = 30_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
};

describe("--web", () => {
  it("runs detached, serves the final state until Close, then exits", async () => {
    const repo = await tempRepo();
    let pid: number | undefined;
    try {
      const res = await execa("node", [cli, ...args, "--web"], {
        cwd: repo,
        reject: false,
        timeout: 15_000,
        env: { GRAPH_EXECUTION_HANDOFF: "detached", SSH_CONNECTION: "1 2 3 4" },
      });
      expect(res.exitCode).toBe(0);
      const m = /Run (\S+) started: (http:\/\/127\.0\.0\.1:(\d+)\/)/.exec(res.stdout);
      expect(m).not.toBeNull();
      const [, runId, url] = m!;
      const webJson = path.join(repo, ".graph-execution", runId!, "web.json");
      pid = (JSON.parse(await readFile(webJson, "utf8")) as { pid: number }).pid;
      await until(async () => {
        const s = (await (await fetch(`${url}state`)).json()) as { summary?: { exitCode: number } };
        return s.summary?.exitCode === 0;
      });
      const close = await fetch(`${url}close`, { method: "POST", headers: { origin: url!.slice(0, -1) } });
      expect(close.status).toBe(200);
      await until(() => !existsSync(webJson) && !alive(pid!));
    } finally {
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60_000);

  it("exits 3 with the foreground command when the hand-off is blocked", async () => {
    const repo = await tempRepo();
    try {
      const res = await execa("node", [cli, ...args, "--web"], {
        cwd: repo,
        reject: false,
        env: { GRAPH_EXECUTION_HANDOFF: "none" },
      });
      expect(res.exitCode).toBe(3);
      expect(res.stdout).toContain("Run this in a terminal:");
      expect(res.stdout).toContain("graph-execution");
      expect(res.stdout).not.toContain("--web");
    } finally {
      await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("is refused by install and readme", async () => {
    for (const sub of [["install", "skills"], ["readme"]]) {
      const res = await execa("node", [cli, ...sub, "--web"], { cwd: root, reject: false });
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("--web");
    }
  });
});
