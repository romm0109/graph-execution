import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempRepo } from "../__fixtures__/repo.js";
import { computeHashes, initialReviewState, StateStore } from "../state/state.js";
import { assertNotRunning, preflight, UsageError } from "./preflight.js";

const fixture = (name: string): string => fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url));
const spec = fixture("spec.md");

let repo: string;
beforeEach(async () => {
  repo = await tempRepo();
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const base = () => ({ cwd: repo, tasksDir: fixture("diamond"), spec, provider: "fake" });

async function refuses(opts: Parameters<typeof preflight>[0], message: string | RegExp, kind?: typeof UsageError) {
  const err = await preflight(opts).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(kind ?? Error);
  expect((err as Error).message).toMatch(message);
  expect(existsSync(path.join(repo, ".graph-execution"))).toBe(false);
}

describe("preflight", () => {
  it("accepts a valid run and creates nothing", async () => {
    const res = await preflight(base());
    expect(res.kind).toBe("run");
    expect(existsSync(path.join(repo, ".graph-execution"))).toBe(false);
  });

  it("refuses a missing spec file", () =>
    refuses({ ...base(), spec: path.join(repo, "nope.md") }, /spec file not found/, UsageError));
  it("refuses an empty spec", () => refuses({ ...base(), spec: fixture("spec-empty.md") }, /empty/, UsageError));
  it("refuses a missing --provider", () =>
    refuses({ ...base(), provider: undefined }, "missing required option --provider <name>", UsageError));
  it("refuses --run without --resume", () =>
    refuses({ ...base(), runId: "x" }, "--run can only be used with --resume", UsageError));
  it("refuses a cyclic graph", () => refuses({ ...base(), tasksDir: fixture("cycle") }, /cycle/i));
  it("refuses an unknown provider", () => refuses({ ...base(), provider: "nope" }, /nope/));
  it("refuses a repository with no commits", async () => {
    await rm(path.join(repo, ".git"), { recursive: true, force: true });
    await execa("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await refuses(base(), "the repository has no commits yet; commit something before running");
  });
  it("refuses a repository nested in .graph-execution", async () => {
    const nested = path.join(repo, ".graph-execution", "wt");
    await mkdir(nested, { recursive: true });
    await execa("git", ["init", "-q", "-b", "main"], { cwd: nested });
    await rm(path.join(repo, ".graph-execution", "wt", ".git", "..", "nothing"), { force: true });
    const err = await preflight({ ...base(), cwd: nested }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/refusing to run inside a graph-execution worktree/);
  });

  it("refuses --resume with a tasks folder", () =>
    refuses({ cwd: repo, resume: true, tasksDir: "x" }, /--resume takes no tasks folder/, UsageError));
  it("refuses --resume when the input changed", async () => {
    const runDir = path.join(repo, ".graph-execution", "r1");
    await mkdir(runDir, { recursive: true });
    const tasksDir = path.join(repo, "tasks");
    await mkdir(tasksDir);
    const specPath = path.join(repo, "spec.md");
    await writeFile(specPath, "one\n");
    const hashes = await computeHashes(path.join(repo, "graph-execution.config.json"), tasksDir, specPath);
    await new StateStore(path.join(runDir, "state.json"), {
      runId: "r1",
      provider: "fake",
      startingCommit: "abc",
      integrationBranch: "graph/r1",
      specPath,
      tasksDir,
      hashes,
      tasks: {},
      review: initialReviewState(),
      createdAt: new Date().toISOString(),
    }).save();
    await writeFile(specPath, "two\n");
    const err = await preflight({ cwd: repo, resume: true }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/the spec changed since the run started/);
  });
});

describe("assertNotRunning", () => {
  it("throws for a live lock and passes for a stale one", async () => {
    const runDir = path.join(repo, ".graph-execution", "r1");
    await mkdir(runDir, { recursive: true });
    const child = execa("node", ["-e", "setInterval(()=>{},1e9)"], { reject: false });
    try {
      await writeFile(path.join(runDir, "lock"), `${child.pid}\n`);
      await expect(assertNotRunning(runDir)).rejects.toThrow(`run r1 is already running (PID ${child.pid})`);
    } finally {
      child.kill("SIGKILL");
      await child;
    }
    await expect(assertNotRunning(runDir)).resolves.toBeUndefined();
  });
});
