import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { testerReportPath } from "../agents/tester.js";
import { defaultConfig } from "../config/config.js";
import { createFakeProvider, fakeScriptSchema } from "../providers/fake.js";
import { runReviewPhase } from "../review/phase.js";
import { formatHeads, parseHeads } from "../review/workspace.js";
import {
  addJointWorktrees,
  buildJointInputs,
  jointDirOf,
  jointRangeChanges,
  jointRepoDir,
  type JointValidation,
  jointWorkspace,
  removeJointWorktrees,
} from "./joint.js";

/** A test timeout, tripled on Windows: its runners are several times slower at processes and git. */
const slow = (ms: number): number => (process.platform === "win32" ? ms * 3 : ms);
const BRANCH = "suite/t";
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;

let api: string;
let web: string;
let suiteDir: string;
let start: Record<string, string>;
let validations: JointValidation[][];

async function commitFile(repo: string, name: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
  await writeFile(path.join(repo, name), content);
  await gitOut(repo, ["add", "-A"]);
  await gitOut(repo, ["commit", "-q", "-m", `add ${name}`]);
}

/** Commits `files` on a new branch `suite/t` of `repo` and returns to `main`. */
async function suiteBranch(repo: string, files: Record<string, string>): Promise<void> {
  await gitOut(repo, ["checkout", "-q", "-b", BRANCH]);
  for (const [name, content] of Object.entries(files)) await commitFile(repo, name, content);
  await gitOut(repo, ["checkout", "-q", "main"]);
}

const repos = () => [
  { name: "api", path: api },
  { name: "web", path: web },
];

function workspace(validate: Record<string, string[]> = {}, hasTestPlan = false) {
  return jointWorkspace({
    suiteDir,
    branch: BRANCH,
    hasTestPlan,
    repos: repos().map((r) => ({
      ...r,
      startingCommit: start[r.name]!,
      dir: jointRepoDir(suiteDir, r.name),
      validate: validate[r.name] ?? [],
      validateParallel: false,
    })),
    onValidation: async (results) => {
      validations.push(results);
    },
  });
}

beforeEach(async () => {
  api = realpathSync.native(await tempRepo());
  web = realpathSync.native(await tempRepo());
  suiteDir = realpathSync.native(await mkdtemp(path.join(tmpdir(), "graph-execution-joint-")));
  start = { api: await gitOut(api, ["rev-parse", "HEAD"]), web: await gitOut(web, ["rev-parse", "HEAD"]) };
  validations = [];
});
afterEach(async () => {
  for (const dir of [suiteDir, api, web]) await rm(dir, RM);
});

async function setUp(apiFiles: Record<string, string> = { "a.txt": "a\n" }): Promise<void> {
  await suiteBranch(api, apiFiles);
  await suiteBranch(web, { "w.txt": "w\n" });
  await addJointWorktrees(suiteDir, BRANCH, repos());
}

describe("joint heads", () => {
  it("round-trips a joint head and refuses a plain sha", () => {
    const a = "a".repeat(40);
    const b = "0123456789abcdef0123456789abcdef01234567";
    const text = `api=${a} web=${b}`;
    expect(parseHeads(text)).toEqual({ api: a, web: b });
    expect(formatHeads(parseHeads(text)!)).toBe(text);
    expect(parseHeads(a)).toBeUndefined();
    expect(parseHeads(`api=${a} web`)).toBeUndefined();
    expect(parseHeads("")).toBeUndefined();
  });
});

describe("jointWorkspace", () => {
  it("joins the repos' diffs and changed files under their names", async () => {
    await setUp();
    const ws = workspace();
    expect(ws.dir).toBe(jointDirOf(suiteDir));
    expect(ws.label).toBe("suite/t in api, web");
    expect(ws.base).toBe(formatHeads(start));
    const diff = await ws.diff();
    expect(diff).toContain("diff --git a/api/a.txt b/api/a.txt");
    expect(diff).toContain("diff --git a/web/w.txt b/web/w.txt");
    const webOnly = await ws.diff(["web/w.txt"]);
    expect(webOnly).toContain("diff --git a/web/w.txt");
    expect(webOnly).not.toContain("a/api/");
    expect(await ws.diff([])).toBe("");
    expect(await ws.changedFiles()).toEqual(["api/a.txt", "web/w.txt"]);
    const changes = await jointRangeChanges(repos().map((r) => ({ name: r.name, repo: r.path, from: start[r.name]!, to: BRANCH })));
    expect(changes.map((c) => c.path)).toEqual(["api/a.txt", "web/w.txt"]);
    expect(changes.every((c) => c.isNew)).toBe(true);
  });

  it("commits leftovers per repo, reports new commits and resets every repo", async () => {
    await setUp();
    const ws = workspace();
    const before = await ws.head();
    expect(parseHeads(before)).toEqual({
      api: await gitOut(api, ["rev-parse", BRANCH]),
      web: await gitOut(web, ["rev-parse", BRANCH]),
    });
    expect(await ws.hasNewCommit(before)).toBe(false);
    await writeFile(path.join(ws.dir, "repos", "web", "x.txt"), "x\n");
    expect(await ws.dirty()).toEqual(["web/x.txt"]);
    // A path that was already dirty stays out.
    expect(await ws.commitLeftovers("m", ["web/x.txt"])).toBe(false);
    expect(await ws.commitLeftovers("m", [])).toBe(true);
    expect(await ws.hasNewCommit(before)).toBe(true);
    const after = await ws.head();
    expect(parseHeads(after)!.api).toBe(parseHeads(before)!.api);
    expect(parseHeads(after)!.web).not.toBe(parseHeads(before)!.web);
    const messages = await ws.messages(before, after);
    expect(messages).toBe("[web]\nm");
    await ws.resetTo(before);
    expect(await ws.head()).toBe(before);
    expect(await gitOut(web, ["rev-parse", BRANCH])).toBe(parseHeads(before)!.web);
    await expect(ws.resetTo(parseHeads(before)!.api!)).rejects.toThrow("not a joint head");
  });

  it("runs each repo's validation in its joint worktree and names the failing repo", async () => {
    await setUp();
    const check = (file: string): string => `node -e "process.exit(require('fs').existsSync('${file}') ? 0 : 1)"`;
    const signal = new AbortController().signal;
    const ok = workspace({ web: [check("w.txt")] });
    expect(ok.checks).toEqual([`cd repos/web && ${check("w.txt")}`]);
    expect(await ok.validate(signal)).toEqual({ ok: true });
    expect(validations.at(-1)!.map(({ at, ...rest }) => (expect(at).toMatch(/^\d{4}-/), rest))).toEqual([
      { repo: "api", ok: true, commands: 0 },
      { repo: "web", ok: true, commands: 1 },
    ]);

    const bad = workspace({ api: [check("a.txt")], web: [check("missing.txt")] });
    const result = await bad.validate(signal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.command).toBe(`web: ${check("missing.txt")}`);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(`## web: $ ${check("missing.txt")} (exit code 1)`);
    expect(validations.at(-1)!.map(({ repo, ok: passed, command, exitCode }) => ({ repo, ok: passed, command, exitCode }))).toEqual([
      { repo: "api", ok: true, command: undefined, exitCode: undefined },
      { repo: "web", ok: false, command: check("missing.txt"), exitCode: 1 },
    ]);
  });

  it("creates and removes a reviewer checkout with every repo under repos/", async () => {
    await setUp();
    const ws = workspace();
    const head = await ws.head();
    const dir = path.join(suiteDir, "worktrees", "review-code-r0");
    await ws.addCheckout(dir, head);
    expect(existsSync(path.join(dir, ".git"))).toBe(true);
    for (const r of repos()) {
      expect(await gitOut(path.join(dir, "repos", r.name), ["rev-parse", "HEAD"])).toBe(parseHeads(head)![r.name]);
    }
    // A commit in the checkout itself lands in its own repository, with the repos left out.
    await writeFile(path.join(dir, "note.txt"), "n\n");
    await gitOut(dir, ["add", "-A"]);
    await gitOut(dir, ["commit", "-q", "-m", "note"]);
    expect(await gitOut(dir, ["ls-files"])).toBe("note.txt");
    await ws.removeCheckout(dir);
    expect(existsSync(dir)).toBe(false);
    for (const r of repos()) expect(await gitOut(r.path, ["worktree", "list"])).not.toContain("review-code-r0");
    // Removing what is not there is fine.
    await ws.removeCheckout(dir);
  });

  it("joins repo files under repo headings and matches globs with or without the repo prefix", async () => {
    await setUp({ "a.txt": "a\n", "REVIEW.md": "No console.log.\n" });
    const ws = workspace();
    expect(await ws.repoFiles(["REVIEW.md", "TESTING.md"])).toEqual({ "REVIEW.md": "## api\n\nNo console.log." });
    expect(ws.matchFiles(["api/src/a.ts", "web/b.md"], ["src/**"])).toEqual(["api/src/a.ts"]);
    expect(ws.matchFiles(["api/src/a.ts", "web/src/b.ts"], ["web/**"])).toEqual(["web/src/b.ts"]);
    expect(ws.matchFiles(["api/src/a.ts", "web/src/b.ts"], ["src/**", "!api/**"])).toEqual(["web/src/b.ts"]);
    expect(ws.matchFiles(["api/src/a.ts", "web/b.md"], ["!**/*.md"])).toEqual(["api/src/a.ts"]);
  });

  it("keeps the joint worktrees on a second add and removes them", async () => {
    await setUp();
    await writeFile(path.join(jointRepoDir(suiteDir, "web"), "kept.txt"), "k\n");
    await addJointWorktrees(suiteDir, BRANCH, repos());
    expect(existsSync(path.join(jointRepoDir(suiteDir, "web"), "kept.txt"))).toBe(true);
    expect(await gitOut(jointRepoDir(suiteDir, "api"), ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(BRANCH);
    await removeJointWorktrees(suiteDir, repos());
    expect(existsSync(jointDirOf(suiteDir))).toBe(false);
    for (const r of repos()) expect((await gitOut(r.path, ["worktree", "list", "--porcelain"])).match(/^worktree /gm)).toHaveLength(1);
  });
});

describe("buildJointInputs", () => {
  it("writes the contract and every repo's spec, and copies the test plan when there is one", async () => {
    const project = realpathSync.native(await mkdtemp(path.join(tmpdir(), "graph-execution-project-")));
    try {
      await mkdir(path.join(project, "specs"));
      await writeFile(path.join(project, "contract.md"), "GET /answer returns 42.\n");
      await writeFile(path.join(project, "specs", "api.md"), "Serve /answer.\n");
      const p = { dir: project, contract: path.join(project, "contract.md") };
      const first = await buildJointInputs(suiteDir, p, repos());
      expect(first.hasTestPlan).toBe(false);
      expect(await readFile(first.specPath, "utf8")).toBe(
        "# Contract\n\nGET /answer returns 42.\n\n# Repo api\n\nServe /answer.\n\n" +
          "# Repo web\n\n(no change planned in this repo; it is checked out for reference)\n",
      );
      const plan = { cases: [{ id: "c1", title: "t", steps: ["s"], expected: "e", priority: "must" }] };
      await writeFile(path.join(project, "test-plan.json"), JSON.stringify(plan));
      const second = await buildJointInputs(suiteDir, p, repos());
      expect(second.hasTestPlan).toBe(true);
      expect(JSON.parse(await readFile(path.join(second.tasksDir, "test-plan.json"), "utf8"))).toEqual(plan);
      await rm(path.join(project, "test-plan.json"));
      expect((await buildJointInputs(suiteDir, p, repos())).hasTestPlan).toBe(false);
      expect(existsSync(path.join(second.tasksDir, "test-plan.json"))).toBe(false);
    } finally {
      await rm(project, RM);
    }
  });
});

describe("runReviewPhase over a joint workspace", () => {
  const blocker = {
    id: "F1",
    severity: "blocker",
    file: "web/w.txt",
    line: 1,
    description: "Wrong content.",
    failureScenario: "Reading w.txt returns the wrong text.",
    status: "open",
  };

  async function review(script: unknown, extra: { human?: { wait: () => Promise<{ review: "apply" }> } } = {}) {
    await setUp();
    const ws = workspace();
    const specPath = path.join(suiteDir, "spec.md");
    await writeFile(specPath, "# Contract\n\nGET /answer returns 42.\n");
    const provider = createFakeProvider(fakeScriptSchema.parse(script));
    const lines: string[] = [];
    const result = await runReviewPhase({
      provider,
      config: defaultConfig(),
      repo: suiteDir,
      runDir: suiteDir,
      integrationWorktree: ws.dir,
      integrationBranch: BRANCH,
      startingCommit: ws.base,
      specPath,
      tasksDir: path.join(suiteDir, "tasks"),
      signal: new AbortController().signal,
      hint: "graph-execution suite --resume",
      log: (l) => lines.push(l),
      workspace: ws,
      ...extra,
    });
    return { ws, provider, result, lines };
  }

  it("gives the reviewers the combined diff and the note, and skips the tester without a test plan", async () => {
    const { provider, result, lines } = await review({});
    expect(result.exitCode).toBe(0);
    const reviewer = provider.calls.find((c) => `${c.role}:${c.label}` === "reviewer:code-r0")!;
    expect(reviewer.prompt).toContain("diff --git a/api/a.txt b/api/a.txt");
    expect(reviewer.prompt).toContain("diff --git a/web/w.txt b/web/w.txt");
    expect(reviewer.prompt).toContain("## Repositories");
    expect(reviewer.prompt).toContain("This change spans several git repositories, checked out under `repos/<name>/` of the current directory: api, web.");
    expect(reviewer.cwd).toBe(path.join(suiteDir, "worktrees", "review-code-r0"));
    expect(provider.calls.filter((c) => c.role === "tester")).toEqual([]);
    const tester = JSON.parse(await readFile(testerReportPath(suiteDir, 0), "utf8"));
    expect(tester.notes).toEqual(["live test not performed: the project has no test-plan.json"]);
    expect(lines).toContain("note: live test not performed: the project has no test-plan.json");
    // The reviewer's checkout is gone, and its commit went to neither repo.
    expect(existsSync(path.join(suiteDir, "worktrees", "review-code-r0"))).toBe(false);
    for (const r of repos()) expect(await gitOut(r.path, ["log", "--format=%s", "--all"])).not.toContain("fake:");
  }, slow(60_000));

  it("commits the fixer's leftovers in the repo it changed and leaves the others", async () => {
    const { ws, provider, result } = await review({
      "reviewer:code-r0": { attempts: [{ report: { findings: [blocker] } }] },
      "fixer:fix-r1": { attempts: [{ write: { "repos/web/fix.txt": "x\n" }, commit: false }] },
      "reviewer:code-r1": { attempts: [{ report: { findings: [{ ...blocker, status: "fixed" }] } }] },
    });
    expect(result.exitCode).toBe(0);
    expect(result.rounds).toHaveLength(2);
    const fixer = provider.calls.find((c) => c.role === "fixer")!;
    expect(fixer.cwd).toBe(ws.dir);
    expect(fixer.prompt).toContain("## Repositories");
    expect(fixer.prompt).toContain("never in the current directory");
    expect(await gitOut(web, ["show", `${BRANCH}:fix.txt`])).toBe("x");
    expect(await gitOut(web, ["log", "-1", "--format=%s", BRANCH])).toBe("Fixer (fix pass 1): changes the agent left uncommitted");
    expect(await gitOut(api, ["log", "-1", "--format=%s", BRANCH])).toBe("add a.txt");
    const second = provider.calls.find((c) => `${c.role}:${c.label}` === "reviewer:code-r1")!;
    expect(second.prompt).toContain("diff --git a/web/fix.txt b/web/fix.txt");
    expect(second.prompt).toContain("[web]");
  }, slow(60_000));

  it("retries a fixer that changed no repo", async () => {
    const { provider, result, lines } = await review({
      "reviewer:code-r0": { attempts: [{ report: { findings: [blocker] } }] },
      // The first attempt commits only in the joint folder itself, which is none of the repos.
      "fixer:fix-r1": { attempts: [{ write: { "fix.txt": "x\n" } }, { write: { "repos/api/fix.txt": "x\n" }, commit: false }] },
      "reviewer:code-r1": { attempts: [{ report: { findings: [{ ...blocker, status: "fixed" }] } }] },
    });
    expect(result.exitCode).toBe(0);
    expect(provider.calls.filter((c) => c.role === "fixer")).toHaveLength(2);
    expect(lines).toContain("fix pass 1: the fixer made no commit; retry 2/3");
    expect(await gitOut(api, ["show", `${BRANCH}:fix.txt`])).toBe("x");
  }, slow(60_000));

  it("records the joint base and head for the human review", async () => {
    const { ws, result } = await review({}, { human: { wait: async () => ({ review: "apply" }) } });
    expect(result.human?.decision).toBe("apply");
    const round = JSON.parse(await readFile(path.join(suiteDir, "human", "round1.json"), "utf8"));
    expect(round.diffBase).toBe(ws.base);
    expect(round.diffHead).toBe(await ws.head());
  }, slow(60_000));
});
