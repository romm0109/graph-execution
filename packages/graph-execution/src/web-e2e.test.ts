import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
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

  it("serves a --content run's page from planning to the end", async () => {
    const repo = await tempRepo();
    let pid: number | undefined;
    try {
      const content = path.join(repo, ".git", "c.md");
      await writeFile(content, "# Build 1.txt\n");
      const res = await execa("node", [cli, "--content", content, "--provider", "fake", "--no-plan-gate", "--web"], {
        cwd: repo,
        reject: false,
        timeout: 15_000,
        env: { GRAPH_EXECUTION_HANDOFF: "detached", SSH_CONNECTION: "1 2 3 4" },
      });
      expect(res.exitCode).toBe(0);
      const [, runId, url] = /Run (\S+) started: (http:\/\/127\.0\.0\.1:(\d+)\/)/.exec(res.stdout)!;
      const webJson = path.join(repo, ".graph-execution", runId!, "web.json");
      pid = (JSON.parse(await readFile(webJson, "utf8")) as { pid: number }).pid;
      let last: { summary?: { exitCode: number }; graph: { nodes: { id: string }[] }; plan?: { status: string; name?: string } } | undefined;
      await until(async () => {
        last = (await (await fetch(`${url}state`)).json()) as typeof last;
        return last?.summary?.exitCode === 0;
      });
      expect(last!.graph.nodes.map((n) => n.id)).toContain("1");
      expect(last!.plan).toEqual(expect.objectContaining({ status: "running", name: "fake-plan" }));
      const close = await fetch(`${url}close`, { method: "POST", headers: { origin: url!.slice(0, -1) } });
      expect(close.status).toBe(200);
      await until(() => !existsSync(webJson) && !alive(pid!));
    } finally {
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60_000);

  it("ends the run process of a --content run at awaiting-approval", async () => {
    const repo = await tempRepo();
    try {
      const content = path.join(repo, ".git", "c.md");
      await writeFile(content, "# Build 1.txt\n");
      const res = await execa("node", [cli, "--content", content, "--provider", "fake", "--web"], {
        cwd: repo,
        reject: false,
        timeout: 15_000,
        env: { GRAPH_EXECUTION_HANDOFF: "detached", SSH_CONNECTION: "1 2 3 4" },
      });
      expect(res.exitCode).toBe(0);
      const runId = /Run (\S+) started:/.exec(res.stdout)![1]!;
      const runDir = path.join(repo, ".graph-execution", runId);
      const stateOf = async () => JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")) as { status: string };
      await until(async () => (await stateOf()).status === "awaiting-approval");
      await until(() => !existsSync(path.join(runDir, "web.json")) && !existsSync(path.join(runDir, "lock")));
    } finally {
      await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60_000);

  it("sends the final awaiting-approval plan view to the open page before the process exits", async () => {
    const repo = await tempRepo();
    try {
      const content = path.join(repo, ".git", "c.md");
      await writeFile(content, "# Build 1.txt\n");
      // A fixed port, so the stream is open before the (fast) fake planner ends.
      const port = await new Promise<number>((resolve) => {
        const srv = net.createServer().listen(0, "127.0.0.1", () => {
          const p = (srv.address() as net.AddressInfo).port;
          srv.close(() => resolve(p));
        });
      });
      const events: { event: string; data: unknown }[] = [];
      const run = execa("node", [cli, "--content", content, "--provider", "fake", "--web"], {
        cwd: repo,
        reject: false,
        timeout: 15_000,
        env: { GRAPH_EXECUTION_HANDOFF: "detached", SSH_CONNECTION: "1 2 3 4", GRAPH_EXECUTION_WEB_PORT: String(port) },
      });
      const stream = async (): Promise<void> => {
        for (const end = Date.now() + 15_000; Date.now() < end; ) {
          const ok = await new Promise<boolean>((resolve) => {
            http
              .get({ host: "127.0.0.1", port, path: "/events" }, (r) => {
                let buf = "";
                r.on("data", (c) => {
                  buf += c;
                  let i;
                  while ((i = buf.indexOf("\n\n")) >= 0) {
                    const chunk = buf.slice(0, i).split("\n");
                    buf = buf.slice(i + 2);
                    const data = chunk.find((l) => l.startsWith("data: "));
                    const event = chunk.find((l) => l.startsWith("event: "))?.slice(7) ?? "message";
                    if (data) events.push({ event, data: JSON.parse(data.slice(6)) });
                  }
                });
                r.on("end", () => resolve(true));
                r.on("error", () => resolve(true));
              })
              .on("error", () => resolve(false));
          });
          if (ok) return;
          await new Promise((r) => setTimeout(r, 10));
        }
      };
      const [res] = await Promise.all([run, stream()]);
      expect(res.exitCode).toBe(0);
      expect(events.at(-1)).toEqual({ event: "end", data: { reason: "exited" } });
      const last = events.filter((e) => e.event === "state").at(-1)!.data as {
        plan: { status: string; name: string; spec: string; tasks: { id: string }[]; approve: string };
      };
      expect(last.plan.status).toBe("awaiting-approval");
      expect(last.plan.name).toBe("fake-plan");
      expect(last.plan.spec).toContain("# Fake plan");
      expect(last.plan.tasks[0]!.id).toBe("1");
      expect(last.plan.approve).toContain("--approve-plan");
      const runId = /Run (\S+) started:/.exec(res.stdout)![1]!;
      const runDir = path.join(repo, ".graph-execution", runId);
      await until(() => !existsSync(path.join(runDir, "web.json")) && !existsSync(path.join(runDir, "lock")));
    } finally {
      await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60_000);

  it("approves a plan with --resume --approve-plan --web and serves the run to the end", async () => {
    const repo = await tempRepo();
    let pid: number | undefined;
    try {
      const content = path.join(repo, ".git", "c.md");
      await writeFile(content, "# Build 1.txt\n");
      const env = { GRAPH_EXECUTION_HANDOFF: "detached", SSH_CONNECTION: "1 2 3 4" };
      const first = await execa("node", [cli, "--content", content, "--provider", "fake"], { cwd: repo, reject: false, timeout: 15_000 });
      expect(first.exitCode).toBe(5);
      const runId = /Run (\S+):/.exec(first.stdout)![1]!;
      const res = await execa("node", [cli, "--resume", "--run", runId, "--approve-plan", "--web"], {
        cwd: repo,
        reject: false,
        timeout: 15_000,
        env,
      });
      expect(res.exitCode, res.stdout + res.stderr).toBe(0);
      const url = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(res.stdout)![1]!;
      const webJson = path.join(repo, ".graph-execution", runId, "web.json");
      pid = (JSON.parse(await readFile(webJson, "utf8")) as { pid: number }).pid;
      await until(async () => {
        const s = (await (await fetch(`${url}state`)).json()) as { summary?: { exitCode: number } };
        return s.summary?.exitCode === 0;
      });
      const close = await fetch(`${url}close`, { method: "POST", headers: { origin: url.slice(0, -1) } });
      expect(close.status).toBe(200);
      await until(() => !existsSync(webJson) && !alive(pid!));
      const state = JSON.parse(await readFile(path.join(repo, ".graph-execution", runId, "state.json"), "utf8")) as { status: string };
      expect(state.status).toBe("applied");
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
