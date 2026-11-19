import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempRepo } from "../__fixtures__/repo.js";
import { cliRun, diamond, onlyRun, readState, type Repo, start, withRepo } from "../__fixtures__/resume.js";
import { resolveCommand } from "./resolve.js";

const ESCALATE = { "task:2": { attempts: [{ escalate: { reason: "r", evidence: "e", questions: [{ id: "q1", question: "A or B?" }] } }] } };
const RESOLUTION = { escalationIds: ["E1"], action: "continue", guidance: "B" };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (fn: () => Promise<boolean> | boolean, ms = 45_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error("timed out");
};

async function writeResolution(repo: Repo, value: unknown, name = "r.json"): Promise<string> {
  const file = path.join(repo.dir, ".git", name);
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

/** Starts the diamond, waits until task 2 escalated and task 3 merged, and stops it with Ctrl+C. */
async function stopAtEscalation(repo: Repo): Promise<{ runId: string; runDir: string }> {
  const child = start(repo);
  let out = "";
  child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
  await until(() => out.includes("waiting for your decision on E1"));
  const { runId, runDir } = await onlyRun(repo);
  await until(async () => (await readState(runDir)).tasks["3"]!.status === "merged");
  child.kill("SIGINT");
  expect((await child).exitCode).toBe(2);
  return { runId, runDir };
}

describe("graph-execution resolve / escalations", () => {
  // Windows has no SIGINT one process can send another.
  it.skipIf(process.platform === "win32")("resolves a stopped run offline, refuses a second resolution, then resumes", () =>
    withRepo(undefined, ESCALATE, async (repo) => {
      const { runId, runDir } = await stopAtEscalation(repo);

      const listed = await cliRun(repo, ["escalations"]);
      expect(listed.exitCode, listed.stderr).toBe(0);
      expect(listed.stdout).toMatch(/^E1\s+task 2\s+open\s+r$/m);

      const file = await writeResolution(repo, RESOLUTION);
      const res = await cliRun(repo, ["resolve", "--file", file]);
      expect(res.exitCode, res.stderr).toBe(0);
      expect(res.stdout.trim()).toBe(`resolved E1; continue with graph-execution --resume --run ${runId}`);
      expect((await readState(runDir)).tasks["2"]).toEqual({ status: "pending", attempts: 0 });

      const after = await cliRun(repo, ["escalations", "--run", runId]);
      expect(after.stdout).toMatch(/^E1\s+task 2\s+resolved\s+r$/m);

      const again = await cliRun(repo, ["resolve", "--run", runId, "--file", file]);
      expect(again.exitCode).toBe(1);
      expect(again.stderr).toContain("refused (not_open)");

      await writeFile(repo.script, JSON.stringify({}));
      const resumed = await cliRun(repo, ["--resume"]);
      expect(resumed.exitCode, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
      expect((await readState(runDir)).tasks["2"]!.status).toBe("merged");
    }), 90_000);

  // A stopped --web run keeps its page up until Close: its `not_waiting` must not keep the resolution out (T1).
  // An abort applied offline ends the run for good: `--resume` refuses it instead of waiting forever (F1).
  it.skipIf(process.platform === "win32")("applies an abort offline behind a stopped run's page, and --resume refuses it", () =>
    withRepo(undefined, ESCALATE, async (repo) => {
      const { runId, runDir } = await stopAtEscalation(repo);
      const server = http.createServer((_req, res) => {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "not_waiting", message: "the run is not live" } }));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      try {
        const { port } = server.address() as AddressInfo;
        await writeFile(path.join(runDir, "web.json"), JSON.stringify({ url: `http://127.0.0.1:${port}/`, pid: process.pid }));
        const file = await writeResolution(repo, { escalationIds: ["E1"], action: "abort" });
        const res = await cliRun(repo, ["resolve", "--run", runId, "--file", file]);
        expect(res.exitCode, res.stderr).toBe(0);
        expect(res.stdout.trim()).toBe("resolved E1; the run is aborted");
      } finally {
        await new Promise((r) => server.close(r));
        await rm(path.join(runDir, "web.json"), { force: true });
      }
      const state = await readState(runDir);
      expect(state.status).toBe("aborted");
      expect(state.abortedBy).toBe("resolution");
      const resumed = await cliRun(repo, ["--resume", "--run", runId]);
      expect(resumed.exitCode).toBe(2);
      expect(resumed.stderr).toContain("ended by an abort resolution");
    }), 90_000);

  it("resolves a live run through its page", () =>
    withRepo(undefined, ESCALATE, async (repo) => {
      let pid: number | undefined;
      let url: string | undefined;
      try {
        const launched = await cliRun(repo, [diamond, "--spec", repo.spec, "--provider", "fake", "--web"], {
          GRAPH_EXECUTION_HANDOFF: "detached",
          SSH_CONNECTION: "1 2 3 4",
        });
        expect(launched.exitCode, launched.stderr).toBe(0);
        const m = /Run (\S+) started: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(launched.stdout);
        expect(m).not.toBeNull();
        url = m![2]!;
        const runDir = path.join(repo.dir, ".graph-execution", m![1]!);
        pid = (JSON.parse(await readFile(path.join(runDir, "web.json"), "utf8")) as { pid: number }).pid;
        await until(async () => {
          const s = (await (await fetch(`${url}state`)).json()) as { nodes?: { id: string; status: string }[] };
          return JSON.stringify(s).includes('"escalated"');
        });
        // The page lists the escalation once task 2 waits for it.
        await until(async () => {
          const e = (await (await fetch(`${url}escalations`)).json()) as { escalations: { id: string; status: string }[] };
          return e.escalations.some((x) => x.id === "E1" && x.status === "open");
        });
        await writeFile(repo.script, JSON.stringify({}));
        const file = await writeResolution(repo, RESOLUTION);
        const res = await cliRun(repo, ["resolve", "--file", file]);
        expect(res.exitCode, res.stderr).toBe(0);
        expect(res.stdout).toContain("resolved E1: task 2 requeued");
        await until(async () => {
          const s = (await (await fetch(`${url}state`)).json()) as { summary?: { exitCode: number } };
          return s.summary?.exitCode === 0;
        });
      } finally {
        if (url) await fetch(`${url}close`, { method: "POST", headers: { origin: url.slice(0, -1) } }).catch(() => undefined);
        if (pid && alive(pid)) {
          await until(() => !alive(pid!), 5_000).catch(() => process.kill(pid!, "SIGKILL"));
        }
      }
    }), 90_000);

  it("exits 2 for a bad resolution file and an unknown run", () =>
    withRepo(undefined, {}, async (repo) => {
      expect((await start(repo)).exitCode).toBe(0);
      const { runId } = await onlyRun(repo);
      const bad = await writeResolution(repo, "{ not json", "bad.json");
      const res = await cliRun(repo, ["resolve", "--file", bad]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("cannot read");

      const invalid = await writeResolution(repo, { escalationIds: [], action: "continue" }, "invalid.json");
      const inv = await cliRun(repo, ["resolve", "--file", invalid]);
      expect(inv.exitCode).toBe(2);
      expect(inv.stderr).toContain("invalid resolution: escalationIds");

      const missing = await cliRun(repo, ["resolve", "--file", path.join(repo.dir, "nope.json")]);
      expect(missing.exitCode).toBe(2);

      const good = await writeResolution(repo, RESOLUTION);
      const unknown = await cliRun(repo, ["resolve", "--run", "no-such-run", "--file", good]);
      expect(unknown.exitCode).toBe(2);
      expect(unknown.stderr).toContain("no run or suite no-such-run");
      expect((await cliRun(repo, ["escalations", "--run", "no-such-run"])).exitCode).toBe(2);

      const none = await cliRun(repo, ["escalations"]);
      expect(none.exitCode).toBe(0);
      expect(none.stdout).toContain(`no escalations in run ${runId}`);
      expect((await readdir(path.join(repo.dir, ".graph-execution"))).length).toBe(1);
      expect(existsSync(path.join(repo.dir, ".graph-execution", runId, "escalations"))).toBe(false);
    }), 60_000);

  it("posts to a live page with the token and reports its refusal", async () => {
    const repo = await tempRepo();
    const seen: { token?: string; body?: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({ token: req.headers["x-graph-execution-token"] as string | undefined, body });
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "not_open", message: "E1 is resolved already" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const runDir = path.join(repo, ".graph-execution", "20260101-000000-abcd");
      await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, "state.json"), "{}");
      const { port } = server.address() as AddressInfo;
      await writeFile(path.join(runDir, "web.json"), JSON.stringify({ url: `http://127.0.0.1:${port}/`, pid: process.pid }));
      const file = path.join(repo, "r.json");
      await writeFile(file, JSON.stringify(RESOLUTION));
      const errs: string[] = [];
      const code = await resolveCommand({
        cwd: repo,
        file: "r.json",
        env: { GRAPH_EXECUTION_WEB_TOKEN: "secret" },
        out: () => undefined,
        err: (t) => errs.push(t),
      });
      expect(code).toBe(1);
      expect(errs).toEqual(["refused (not_open): E1 is resolved already"]);
      expect(seen).toEqual([{ token: "secret", body: JSON.stringify(RESOLUTION) }]);
    } finally {
      await new Promise((r) => server.close(r));
      await rm(repo, { recursive: true, force: true });
    }
  });
});
