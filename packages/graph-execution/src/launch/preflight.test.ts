import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  vi.unstubAllEnvs();
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Leaves git with no identity at all for `repo`: no config at any level, no env vars, no auto-detection. */
async function withoutIdentity(dir: string): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "no-identity-home-"));
  await execa("git", ["config", "--unset", "user.name"], { cwd: dir });
  await execa("git", ["config", "--unset", "user.email"], { cwd: dir });
  // Without this, git may auto-detect user@<fqdn> on some machines and succeed.
  await execa("git", ["config", "user.useConfigOnly", "true"], { cwd: dir });
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", home);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  for (const v of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) {
    vi.stubEnv(v, undefined);
  }
}

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

  it("refuses a repository without a git identity", async () => {
    await withoutIdentity(repo);
    await refuses(base(), /git has no commit identity/);
    await expect(preflight(base())).rejects.toThrow("git config --global user.email");
  });
  it("accepts an identity from the GIT_AUTHOR_* and GIT_COMMITTER_* env vars", async () => {
    await withoutIdentity(repo);
    vi.stubEnv("GIT_AUTHOR_NAME", "A");
    vi.stubEnv("GIT_AUTHOR_EMAIL", "a@example.com");
    vi.stubEnv("GIT_COMMITTER_NAME", "C");
    vi.stubEnv("GIT_COMMITTER_EMAIL", "c@example.com");
    expect((await preflight(base())).kind).toBe("run");
  });
  it("refuses an author identity without a committer", async () => {
    await withoutIdentity(repo);
    vi.stubEnv("GIT_AUTHOR_NAME", "A");
    vi.stubEnv("GIT_AUTHOR_EMAIL", "a@example.com");
    await refuses(base(), /git has no commit identity/);
  });
  it("accepts a repo-local identity", async () => {
    await withoutIdentity(repo);
    await execa("git", ["config", "user.name", "X"], { cwd: repo });
    await execa("git", ["config", "user.email", "x@x"], { cwd: repo });
    expect((await preflight(base())).kind).toBe("run");
  });
  it("refuses --resume without a git identity", async () => {
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
      humanReview: false,
      startingCommit: "abc",
      integrationBranch: "graph/r1",
      specPath,
      tasksDir,
      hashes,
      tasks: {},
      review: initialReviewState(),
      createdAt: new Date().toISOString(),
    }).save();
    await withoutIdentity(repo);
    await expect(preflight({ cwd: repo, resume: true })).rejects.toThrow(/git has no commit identity/);
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
      humanReview: false,
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

  it("refuses --resume of a run that already finished", async () => {
    const tasksDir = path.join(repo, "tasks");
    await mkdir(tasksDir);
    const specPath = path.join(repo, "spec.md");
    await writeFile(specPath, "one\n");
    const hashes = await computeHashes(path.join(repo, "graph-execution.config.json"), tasksDir, specPath);
    const resumeAs = async (status: "applied" | "done" | "failed"): Promise<Error | undefined> => {
      const runDir = path.join(repo, ".graph-execution", "r1");
      await rm(runDir, { recursive: true, force: true });
      await mkdir(runDir, { recursive: true });
      await new StateStore(path.join(runDir, "state.json"), {
        runId: "r1",
        provider: "fake",
        humanReview: false,
        startingCommit: "abc",
        integrationBranch: "graph/r1",
        specPath,
        tasksDir,
        hashes,
        tasks: {},
        review: initialReviewState(),
        createdAt: new Date().toISOString(),
        status,
      }).save();
      return preflight({ cwd: repo, resume: true }).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
    };
    for (const status of ["applied", "done"] as const) {
      const err = await resumeAs(status);
      expect(err).toBeInstanceOf(UsageError);
      expect(err?.message).toMatch(/already finished/);
      expect(err?.message).toContain(`(${status})`);
    }
    // A failed run is resumable; whatever else stops it here, it is not that it finished.
    expect((await resumeAs("failed"))?.message ?? "").not.toMatch(/already finished/);
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
