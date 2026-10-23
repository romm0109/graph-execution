import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { initialReviewState, type RunState } from "../state/state.js";
import { scan } from "./scan.js";

let repo: string;
beforeEach(async () => {
  repo = await tempRepo();
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

export const stateOf = (runId: string, status?: string): RunState =>
  ({
    runId,
    provider: "fake",
    humanReview: false,
    startingCommit: "abc",
    integrationBranch: `graph/${runId}`,
    specPath: "/spec.md",
    tasksDir: "/tasks",
    hashes: { config: "", tasks: "t", spec: "s" },
    review: initialReviewState(),
    tasks: { "1": { status: "pending", attempts: 0 } },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(status ? { status } : {}),
  }) as RunState;

export async function makeRun(repo: string, id: string, status?: string, lock?: number): Promise<void> {
  const dir = path.join(repo, ".graph-execution", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "state.json"), JSON.stringify(stateOf(id, status)));
  if (lock !== undefined) await writeFile(path.join(dir, "lock"), `${lock}\n`);
}

/** A suite folder `suite-<rid>` with `suite.json`, a feature run folder per `features` entry, and the branches. */
export async function makeSuite(repo: string, rid: string, status: string, features: string[], lock?: number): Promise<string> {
  const dir = path.join(repo, ".graph-execution", `suite-${rid}`);
  await mkdir(dir, { recursive: true });
  const suite = {
    suiteId: rid,
    status,
    provider: "fake",
    concurrency: 1,
    startingCommit: "abc",
    merge: true,
    features: features.map((runId, i) => ({ name: `f${i}`, tasksDir: "/t", prd: "/p", runId, status: "done" })),
    integrationBranch: `suite/${rid}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  await writeFile(path.join(dir, "suite.json"), JSON.stringify(suite));
  for (const f of features) {
    await mkdir(path.join(dir, "features", f), { recursive: true });
    await writeFile(path.join(dir, "features", f, "state.json"), JSON.stringify(stateOf(f, "done")));
  }
  if (lock !== undefined) await writeFile(path.join(dir, "lock"), `${lock}\n`);
  return dir;
}

/**
 * A two-repo suite launched from a non-repo `home`: `suite-<rid>` with repos `a` and `b` (temp repos), the branches
 * `suite/<rid>` and `graph/<run-id>` in each, and the pointer file in both.
 */
export async function makeTwoRepoSuite() {
  const home = await mkdtemp(path.join(tmpdir(), "ge-home-"));
  const a = await tempRepo();
  const b = await tempRepo();
  const rid = "20260101-000000-aaaa";
  const suiteId = `suite-${rid}`;
  const runs = { a: "run-a", b: "run-b" };
  const dir = path.join(home, ".graph-execution", suiteId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "suite.json"),
    JSON.stringify({
      suiteId,
      status: "done",
      provider: "fake",
      concurrency: 1,
      startingCommit: "abc",
      repos: [a, b].map((root, i) => ({ name: i === 0 ? "a" : "b", root, startingCommit: "abc" })),
      merge: false,
      features: [
        { name: "fa", repo: "a", tasksDir: "/t", prd: "/p", runId: runs.a, status: "done" },
        { name: "fb", repo: "b", tasksDir: "/t", prd: "/p", runId: runs.b, status: "done" },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  for (const [root, run] of [[a, runs.a], [b, runs.b]] as const) {
    await gitOut(root, ["branch", `suite/${rid}`]);
    await gitOut(root, ["branch", `graph/${run}`]);
    await mkdir(path.join(root, ".graph-execution", "_suites"), { recursive: true });
    await writeFile(path.join(root, ".graph-execution", "_suites", `${suiteId}.json`), JSON.stringify({ suiteDir: dir, features: [run] }));
  }
  const cleanup = async (): Promise<void> => {
    for (const d of [home, a, b]) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { home, a, b, rid, suiteId, dir, runs, cleanup };
}

export const branch = (repo: string, name: string) => gitOut(repo, ["branch", name]);

describe("scan", () => {
  it("classifies runs, finds branches, orphans and checked-out branches", async () => {
    const child = execa(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
    child.catch(() => undefined);
    try {
      await makeRun(repo, "a-applied", "applied");
      await makeRun(repo, "b-done", "done");
      await makeRun(repo, "c-nostatus");
      await makeRun(repo, "d-running", "running", 2 ** 22 + 12345);
      await makeRun(repo, "e-live", "running", child.pid);
      await makeRun(repo, "suite-x", "done");
      await makeRun(repo, "_tmp", "done");
      const broken = path.join(repo, ".graph-execution", "f-broken");
      await mkdir(broken, { recursive: true });
      await writeFile(path.join(broken, "state.json"), "{nope");
      await mkdir(path.join(repo, ".graph-execution", "no-state"), { recursive: true });
      for (const b of ["graph/a-applied", "graph-task/a-applied/1", "graph-task/a-applied/2", "graph/old", "graph-task/old/1"]) {
        await branch(repo, b);
      }

      const result = await scan(repo);
      expect(result.runs.map((r) => r.id)).toEqual(["a-applied", "b-done", "c-nostatus", "d-running", "e-live", "f-broken"]);
      const by = Object.fromEntries(result.runs.map((r) => [r.id, r]));
      expect(by["a-applied"]).toMatchObject({ kind: "applied", status: "applied" });
      expect(by["a-applied"]!.branches).toEqual(["graph/a-applied", "graph-task/a-applied/1", "graph-task/a-applied/2"]);
      expect(by["b-done"]!.kind).toBe("done");
      expect(by["c-nostatus"]!.kind).toBe("unfinished");
      expect(by["d-running"]).toMatchObject({ kind: "unfinished", status: "running" });
      expect(by["d-running"]!.pid).toBeUndefined();
      expect(by["e-live"]).toMatchObject({ kind: "live", pid: child.pid });
      expect(by["f-broken"]).toMatchObject({ kind: "unfinished", status: "unknown" });
      expect(by["a-applied"]!.sizeBytes).toBeGreaterThan(0);
      expect(result.orphans).toEqual(["graph-task/old/1", "graph/old"]);
      expect(result.checkedOut).toContain("main");
    } finally {
      child.kill();
    }
  });

  it("treats a suite as one entry owning its feature branches", async () => {
    await makeSuite(repo, "20260102-000000-ab12", "applied", ["f-one", "f-two"]);
    for (const b of ["suite/20260102-000000-ab12", "graph/f-one", "graph/f-two", "graph-task/f-one/1", "suite/lonely"]) {
      await branch(repo, b);
    }
    const result = await scan(repo);
    expect(result.runs.map((r) => r.id)).toEqual(["suite-20260102-000000-ab12"]);
    expect(result.runs[0]).toMatchObject({ type: "suite", kind: "applied", features: ["f-one", "f-two"] });
    expect(result.runs[0]!.branches).toEqual([
      "suite/20260102-000000-ab12",
      "graph/f-one",
      "graph-task/f-one/1",
      "graph/f-two",
    ]);
    expect(result.runs[0]!.sizeBytes).toBeGreaterThan(0);
    expect(result.orphans).toEqual(["suite/lonely"]);
  });

  it("does not take the branches of a pointed-to suite for orphans, until its folder is gone", async () => {
    const s = await makeTwoRepoSuite();
    try {
      expect((await scan(s.a)).orphans).toEqual([]);
      await rm(s.dir, { recursive: true });
      expect((await scan(s.a)).orphans).toEqual([`graph/${s.runs.a}`, `suite/${s.rid}`]);
    } finally {
      await s.cleanup();
    }
  });
});
