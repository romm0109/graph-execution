import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { spec, tasksDir } from "../__fixtures__/review-phase.js";
import { configSchema } from "../config/config.js";
import type { AgentRunOptions } from "../providers/types.js";
import { createFakeProvider, fakeScriptSchema, type FakeProvider } from "../providers/fake.js";
import { type ReviewRepo, runReviewPhase } from "./phase.js";

const BRANCH = "suite/x";
let workspace: string;
let roots: string[];
let lines: string[];

const addRepo = async (name: string, validate: string[]): Promise<ReviewRepo> => {
  const repo = await tempRepo();
  roots.push(repo);
  await execa("git", ["branch", BRANCH], { cwd: repo });
  const worktree = path.join(workspace, name);
  await execa("git", ["worktree", "add", worktree, BRANCH], { cwd: repo });
  return {
    name,
    repo,
    integrationWorktree: worktree,
    integrationBranch: BRANCH,
    startingCommit: await gitOut(repo, ["rev-parse", "main"]),
    config: configSchema.parse({ validate }),
  };
};

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "graph-execution-ws-"));
  roots = [];
  lines = [];
});
afterEach(async () => {
  for (const dir of [workspace, ...roots]) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const review = async (
  repos: ReviewRepo[],
  script: unknown = {},
  extra: { validateOnly?: boolean; reviewFiles?: string[]; onRun?: (opts: AgentRunOptions) => void } = {},
) => {
  const fake = createFakeProvider(fakeScriptSchema.parse(script));
  const innerRun = fake.run.bind(fake);
  const provider: FakeProvider = Object.assign(fake, {
    run: (opts: AgentRunOptions) => {
      extra.onRun?.(opts);
      return innerRun(opts);
    },
  });
  const runDir = await mkdtemp(path.join(tmpdir(), "graph-execution-rd-"));
  roots.push(runDir);
  const result = await runReviewPhase({
    provider,
    config: configSchema.parse({ validationRounds: 2 }),
    repo: repos[0]!.repo,
    runDir,
    integrationWorktree: repos[0]!.integrationWorktree,
    integrationBranch: BRANCH,
    startingCommit: repos[0]!.startingCommit,
    specPath: spec,
    tasksDir,
    signal: new AbortController().signal,
    hint: "resume",
    log: (l) => lines.push(l),
    validateOnly: extra.validateOnly ?? true,
    ...(extra.validateOnly === false ? { fixPasses: 1 } : {}),
    ...(extra.reviewFiles ? { reviewFiles: extra.reviewFiles } : {}),
    repos,
    workspace,
  });
  return { provider, result };
};

const fixerCalls = (p: FakeProvider) => p.calls.filter((c) => c.role === "fixer");

describe("multi-repo review phase", () => {
  it("runs each repo's validate in its own worktree only", async () => {
    const a = await addRepo("a", [`node -e "require('fs').writeFileSync('ran-a','')"`]);
    const b = await addRepo("b", []);
    const { result } = await review([a, b]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(workspace, "a", "ran-a"))).toBe(true);
    expect(existsSync(path.join(workspace, "b", "ran-a"))).toBe(false);
  });

  it("sends a failing repo to the fixer in the workspace and commits only where it changed", async () => {
    const a = await addRepo("a", []);
    const b = await addRepo("b", ['test -f fixed.txt']);
    const aBefore = await gitOut(a.repo, ["rev-parse", BRANCH]);
    const bBefore = await gitOut(b.repo, ["rev-parse", BRANCH]);
    const { provider, result } = await review([a, b], {
      "fixer:fix-r0-v1": { attempts: [{ write: { "b/fixed.txt": "ok\n" } }] },
    });
    expect(result.exitCode).toBe(0);
    const calls = fixerCalls(provider);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe(workspace);
    expect(calls[0]!.prompt).toContain("[b] test -f fixed.txt");
    expect(calls[0]!.prompt).toContain("a, b");
    expect(await gitOut(a.repo, ["rev-parse", BRANCH])).toBe(aBefore);
    expect(await gitOut(b.repo, ["rev-list", "--count", `${bBefore}..${BRANCH}`])).toBe("1");
  });

  it("fails an attempt that writes nothing with no_commit and resets both repos before the retry", async () => {
    const a = await addRepo("a", []);
    const b = await addRepo("b", ["test -f fixed.txt"]);
    const heads = [await gitOut(a.repo, ["rev-parse", BRANCH]), await gitOut(b.repo, ["rev-parse", BRANCH])];
    const { result } = await review([a, b], {
      "fixer:fix-r0-v1": { attempts: [{ commit: false, write: {} }, { write: { "b/fixed.txt": "ok\n" } }] },
    });
    expect(result.exitCode).toBe(0);
    expect(lines).toContain("validation fix round 1: the fixer made no commit in any repo; retry 2/3");
    expect(await gitOut(a.repo, ["rev-parse", BRANCH])).toBe(heads[0]);
    expect(await gitOut(b.repo, ["rev-list", "--count", `${heads[1]}..${BRANCH}`])).toBe("1");
  });

  it("behaves as before without repos", async () => {
    const repo = await tempRepo();
    roots.push(repo);
    await execa("git", ["branch", BRANCH], { cwd: repo });
    const wt = path.join(workspace, "solo");
    await execa("git", ["worktree", "add", wt, BRANCH], { cwd: repo });
    const provider = createFakeProvider(fakeScriptSchema.parse({ "fixer:fix-r0-v1": { attempts: [{ write: { "fixed.txt": "ok\n" } }] } }));
    const runDir = await mkdtemp(path.join(tmpdir(), "graph-execution-rd-"));
    roots.push(runDir);
    const result = await runReviewPhase({
      provider,
      config: configSchema.parse({ validate: ["test -f fixed.txt"] }),
      repo,
      runDir,
      integrationWorktree: wt,
      integrationBranch: BRANCH,
      startingCommit: await gitOut(repo, ["rev-parse", "main"]),
      specPath: spec,
      tasksDir,
      signal: new AbortController().signal,
      hint: "resume",
      log: (l) => lines.push(l),
      validateOnly: true,
    });
    expect(result.exitCode).toBe(0);
    expect(fixerCalls(provider)[0]).toMatchObject({ cwd: wt });
    expect(await gitOut(repo, ["show", `${BRANCH}:fixed.txt`])).toBe("ok");
  });

  describe("reviewers", () => {
    const commitFile = async (r: ReviewRepo, file: string, text: string) => {
      await writeFile(path.join(r.integrationWorktree, file), text);
      await execa("git", ["add", "-A"], { cwd: r.integrationWorktree });
      await execa("git", ["commit", "-m", `add ${file}`], { cwd: r.integrationWorktree });
    };
    const setup = async (reviewMdIn?: "b") => {
      const a = await addRepo("a", []);
      const b = await addRepo("b", []);
      await commitFile(a, "x.txt", "from a\n");
      await commitFile(b, "x.txt", "from b\n");
      if (reviewMdIn) await writeFile(path.join(b.repo, "REVIEW.md"), "no tabs in b\n");
      return [a, b];
    };
    const full = { validateOnly: false };

    it("runs each reviewer in a folder with a detached worktree of every repo", async () => {
      const repos = await setup();
      const seen: Record<string, boolean[]> = {};
      const { provider } = await review(repos, {}, {
        ...full,
        onRun: (o) => {
          if (o.role === "reviewer" || o.role === "tester")
            seen[o.role] = ["a", "b"].map((n) => existsSync(path.join(o.cwd, n, ".git")));
        },
      });
      expect(seen).toEqual({ reviewer: [true, true], tester: [true, true] });
      expect(provider.calls.some((c) => c.role === "reviewer")).toBe(true);
    });

    it("prefixes the diff with each repo's name", async () => {
      const repos = await setup();
      const { provider } = await review(repos, {}, full);
      const prompt = provider.calls.find((c) => c.role === "reviewer")!.prompt;
      expect(prompt).toContain("a/a/x.txt");
      expect(prompt).toContain("b/b/x.txt");
    });

    it("joins REVIEW.md under the repo heading", async () => {
      const repos = await setup("b");
      const { provider } = await review(repos, {}, full);
      const prompt = provider.calls.find((c) => c.role === "reviewer")!.prompt;
      expect(prompt).toContain("## b\n\nno tabs in b");
      expect(prompt).not.toContain("## a\n\n");
    });

    it("limits each repo's diff to its reviewFiles", async () => {
      const repos = await setup();
      const { provider } = await review(repos, {}, { ...full, reviewFiles: ["b/x.txt"] });
      const prompt = provider.calls.find((c) => c.role === "reviewer")!.prompt;
      expect(prompt).toContain("b/b/x.txt");
      expect(prompt).not.toContain("a/a/x.txt");
    });

    it("leaves no review worktree in any repo", async () => {
      const repos = await setup();
      await review(repos, {}, full);
      for (const r of repos) expect(await gitOut(r.repo, ["worktree", "list"])).not.toContain("review-");
    });
  });
});
