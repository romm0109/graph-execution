import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempRepo } from "../__fixtures__/repo.js";
import { createFakeProvider } from "../providers/fake.js";
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

  describe("reviewers file", () => {
    const security = { id: "security", type: "diff", name: "Security", repoFile: "SECURITY_REVIEW.md" };
    const write = async (name: string, content: unknown): Promise<string> => {
      const file = path.join(repo, ".git", name);
      await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
      return file;
    };
    const run = async (opts: Parameters<typeof preflight>[0]) => {
      const res = await preflight(opts);
      if (res.kind !== "run") throw new Error("expected a run");
      return res;
    };

    it("refuses a missing file, naming its path", () =>
      refuses({ ...base(), reviewers: "nope.json", env: {} }, new RegExp(`reviewers file not found: ${path.join(repo, "nope.json").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`), UsageError));
    it("refuses an invalid file with the field path", async () => {
      const file = await write("bad.json", { reviewers: [{ ...security, repoFile: "../x.md" }] });
      await refuses({ ...base(), reviewers: file, env: {} }, /invalid reviewers file .*\n {2}reviewers\.0\.repoFile: /, UsageError);
    });
    it("reads the env var without a flag, and the flag wins over it", async () => {
      const a = await write("a.json", { reviewers: [security, { ...security, id: "perf", name: "Perf", repoFile: "PERF_REVIEW.md", enabled: false }] });
      const b = await write("b.json", { reviewers: [] });
      const fromEnv = await run({ ...base(), env: { GRAPH_EXECUTION_REVIEWERS: a } });
      expect(fromEnv.reviewersFile).toBe(a);
      expect(fromEnv.reviewers.map((r) => r.id)).toEqual(["security"]);
      const fromFlag = await run({ ...base(), reviewers: b, env: { GRAPH_EXECUTION_REVIEWERS: a } });
      expect(fromFlag.reviewersFile).toBe(b);
      expect(fromFlag.reviewers).toEqual([]);
    });
    it("uses the built-ins when the env var is empty", async () => {
      const res = await run({ ...base(), env: { GRAPH_EXECUTION_REVIEWERS: "" } });
      expect(res.reviewersFile).toBeUndefined();
      expect(res.reviewers.map((r) => r.id)).toEqual(["code", "tester"]);
    });
    it("refuses --resume with --reviewers", () =>
      refuses({ cwd: repo, resume: true, reviewers: "x" }, /--resume takes no --reviewers/, UsageError));

    it("refuses --resume when the run's copy of the reviewers file changed", async () => {
      const runDir = path.join(repo, ".graph-execution", "r1");
      await mkdir(runDir, { recursive: true });
      const tasksDir = path.join(repo, "tasks");
      await mkdir(tasksDir);
      const specPath = path.join(repo, "spec.md");
      await writeFile(specPath, "one\n");
      const copy = path.join(runDir, "reviewers.json");
      await writeFile(copy, JSON.stringify({ reviewers: [security] }));
      const hashes = await computeHashes(path.join(repo, "graph-execution.config.json"), tasksDir, specPath, copy);
      expect(hashes.reviewers).not.toBe("");
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
      await writeFile(copy, JSON.stringify({ reviewers: [] }));
      const err = await preflight({ cwd: repo, resume: true }).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(/the reviewers file changed since the run started/);
    });
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

describe("preflight run flags (KAN-89)", () => {
  it("refuses an override on --resume", async () => {
    await refuses(
      { cwd: repo, resume: true, overrides: { attempts: 2 } },
      /cannot change --attempts on --resume: the run keeps the options it started with/,
      UsageError,
    );
    await refuses({ cwd: repo, resume: true, overrides: { validateParallel: false } }, /--no-validate-parallel/, UsageError);
  });

  it("resumes with the overrides saved in the run", async () => {
    const runDir = path.join(repo, ".graph-execution", "r1");
    await mkdir(runDir, { recursive: true });
    const tasksDir = fixture("diamond");
    const specPath = spec;
    const hashes = await computeHashes(path.join(repo, "graph-execution.config.json"), tasksDir, specPath);
    await new StateStore(path.join(runDir, "state.json"), {
      runId: "r1",
      provider: "fake",
      humanReview: false,
      overrides: { attempts: 1, fixPasses: 0 },
      startingCommit: "abc",
      integrationBranch: "graph/r1",
      specPath,
      tasksDir,
      hashes,
      tasks: {},
      review: initialReviewState(),
      createdAt: new Date().toISOString(),
    }).save();
    const res = await preflight({ cwd: repo, resume: true });
    expect(res.kind).toBe("resume");
    if (res.kind !== "resume") return;
    expect(res.config.attempts).toBe(1);
    expect(res.config.fixPasses).toBe(0);
    expect(res.config.validationRounds).toBe(3);
  });

  it("applies the overrides to a new run's config", async () => {
    const res = await preflight({ ...base(), overrides: { fixPasses: 1 } });
    expect(res.kind).toBe("run");
    if (res.kind !== "run") return;
    expect(res.env.config.fixPasses).toBe(1);
  });
});

describe("preflight --content", () => {
  it("returns the plan kind for a readable content file", async () => {
    const content = path.join(repo, ".git", "c.md");
    await writeFile(content, "# Plan me\n");
    const pre = await preflight({ cwd: repo, content, provider: "fake" });
    expect(pre.kind).toBe("plan");
  });

  it("refuses a tasks folder, --spec, an empty content file and --no-plan-gate without --content", async () => {
    const content = path.join(repo, ".git", "c.md");
    await writeFile(content, "# Plan me\n");
    const both = "--content cannot be used with a tasks folder or --spec: the planner writes them";
    await expect(preflight({ cwd: repo, content, tasksDir: fixture("diamond"), provider: "fake" })).rejects.toThrow(both);
    await expect(preflight({ cwd: repo, content, spec, provider: "fake" })).rejects.toThrow(both);
    await expect(preflight({ cwd: repo, content, provider: undefined })).rejects.toThrow("missing required option --provider");
    await writeFile(content, "");
    await expect(preflight({ cwd: repo, content, provider: "fake" })).rejects.toThrow(`content file is empty: ${content}`);
    await expect(preflight({ cwd: repo, tasksDir: fixture("diamond"), spec, provider: "fake", planGate: false })).rejects.toThrow(
      "--no-plan-gate needs --content",
    );
    await expect(preflight({ cwd: repo, resume: true, content })).rejects.toThrow(
      "--resume takes no tasks folder, --spec, --content, --refs or --provider",
    );
  });

  describe("plan approval on resume", () => {
    const setup = async (status: string) => {
      const runDir = path.join(repo, ".graph-execution", "r1");
      await mkdir(runDir, { recursive: true });
      await new StateStore(path.join(runDir, "state.json"), {
        runId: "r1",
        provider: "fake",
        startingCommit: (await execa("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout,
        integrationBranch: "graph/r1",
        tasks: {},
        review: initialReviewState(),
        createdAt: new Date().toISOString(),
        plan: { contentPath: path.join(runDir, "plan", "content.md"), refs: [], gate: true, attempts: 1, questions: [], dropped: [], feedback: [] },
        humanReview: false,
        status: status as "planning",
      }).save();
      return runDir;
    };

    it("refuses needs-info, and awaiting-approval without --approve-plan or --replan", async () => {
      await setup("needs-info");
      await expect(preflight({ cwd: repo, resume: true, runId: "r1" })).rejects.toThrow("cannot resume run r1: it needs more information");
      await setup("awaiting-approval");
      await expect(preflight({ cwd: repo, resume: true, runId: "r1" })).rejects.toThrow(
        "run r1 waits for approval of its plan: resume it with --approve-plan to run it, or with --replan <file> to plan again with your feedback",
      );
    });

    it("plans a run killed while planning again", async () => {
      await setup("planning");
      const pre = await preflight({ cwd: repo, resume: true, runId: "r1", providerInstance: createFakeProvider() });
      expect(pre.kind).toBe("replan");
      expect(pre.kind === "replan" ? pre.feedback : "x").toBeUndefined();
    });

    it("reads the --replan file of a run waiting for approval", async () => {
      await setup("awaiting-approval");
      const fb = path.join(repo, ".git", "fb.md");
      await writeFile(fb, "Split it in two\n");
      const pre = await preflight({ cwd: repo, resume: true, runId: "r1", replan: fb, providerInstance: createFakeProvider() });
      expect(pre.kind).toBe("replan");
      expect(pre.kind === "replan" && pre.feedback).toBe("Split it in two");
      await writeFile(fb, "");
      await expect(preflight({ cwd: repo, resume: true, runId: "r1", replan: fb })).rejects.toThrow(`feedback file is empty: ${fb}`);
      await expect(preflight({ cwd: repo, resume: true, runId: "r1", replan: path.join(repo, "missing.md") })).rejects.toThrow(
        "feedback file not found",
      );
    });

    it("refuses the flags without --resume, together, or on a run not waiting for approval", async () => {
      await expect(preflight({ cwd: repo, approvePlan: true })).rejects.toThrow("--approve-plan can only be used with --resume");
      await expect(preflight({ cwd: repo, replan: "fb.md" })).rejects.toThrow("--replan can only be used with --resume");
      await setup("awaiting-approval");
      await expect(preflight({ cwd: repo, resume: true, runId: "r1", approvePlan: true, replan: "fb.md" })).rejects.toThrow(
        "--approve-plan and --replan cannot be used together",
      );
      await setup("planning");
      await expect(preflight({ cwd: repo, resume: true, runId: "r1", approvePlan: true })).rejects.toThrow(
        "--approve-plan: run r1 is not waiting for approval (status planning)",
      );
      await setup("failed");
      await expect(preflight({ cwd: repo, resume: true, runId: "r1", replan: "fb.md" })).rejects.toThrow(
        "--replan: run r1 is not waiting for approval (status failed)",
      );
    });
  });
});
