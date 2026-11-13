import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { watchIdle } from "../agents/idle.js";
import { watchLoops } from "../agents/loop.js";
import { loadConfig } from "../config/config.js";
import {
  addDetachedWorktree,
  addWorktree,
  commitLeftovers,
  currentHead,
  dirtyPaths,
  hasNewCommit,
  rangeChanges,
  removeWorktreeIfPresent,
  resetHard,
  resolveRef,
  RM_RETRY,
} from "../git/git.js";
import { createMergeLock } from "../git/mutex.js";
import { TEST_PLAN_FILE } from "../graph/testPlan.js";
import { getProvider } from "../providers/index.js";
import type { Provider } from "../providers/types.js";
import { codeReviewSkipped, runReviewPhase } from "../review/phase.js";
import { matchFiles, readRunReviewers } from "../review/reviewers.js";
import {
  formatHeads,
  parseHeads,
  prefixPath,
  readOptional,
  type ReviewWorkspace,
  splitPrefixed,
} from "../review/workspace.js";
import { type ChangedFile, RunEmitter } from "../runner/events.js";
import type { RetryHub } from "../runner/retry-hub.js";
import { teeOutput } from "../runner/run.js";
import { EXIT_SUCCESS, type ExitCode } from "../state/errors.js";
import { trackProcesses } from "../state/processes.js";
import { initialReviewState } from "../state/state.js";
import { writeAgentLogs } from "../ui/store.js";
import { type CommandsResult, runCommands } from "../validate/commands.js";
import { suiteBranchOf } from "./e2e.js";
import type { Project } from "./project.js";
import type { SuiteStore } from "./state.js";

export const jointDirOf = (suiteDir: string): string => path.join(suiteDir, "worktrees", "joint");
export const jointRepoDir = (suiteDir: string, name: string): string => path.join(jointDirOf(suiteDir), "repos", name);

export interface JointContext {
  suiteId: string;
  suiteDir: string;
  store: SuiteStore;
  log: (line: string) => void;
  project: Project;
  signal?: AbortSignal;
  reviewHub?: RetryHub;
  reviewEvents?: RunEmitter;
}

export interface JointResult {
  /** False: open findings remain; the suite ends `failed` and nothing is applied. */
  ok: boolean;
  /** The exit code when not ok, or with `keep`; EXIT_REVIEW_FAILED / EXIT_SUCCESS when omitted. */
  exitCode?: ExitCode;
  /** Set when the phase passed but nothing may be applied (dropped in the human review, code review not performed): the reason for the log. */
  keep?: string;
}

export interface JointRepo {
  name: string;
  path: string;
  startingCommit: string;
  /** Its joint worktree: jointRepoDir(suiteDir, name). */
  dir: string;
  validate: readonly string[];
  validateParallel: boolean;
}

export interface JointValidation {
  repo: string;
  ok: boolean;
  commands: number;
  command?: string;
  exitCode?: number;
  at: string;
}

export interface JointWorkspaceOptions {
  suiteDir: string;
  /** `suite/<rid>` */
  branch: string;
  repos: JointRepo[];
  /** Whether the project has a test-plan.json; without one the tester is not run. */
  hasTestPlan: boolean;
  /** The project folder: its `tasks/<name>/` folders are what each repo's feature was built from. */
  projectDir?: string;
  /** Called after every validation with one entry per repo, in project order. */
  onValidation?: (results: JointValidation[]) => Promise<void>;
}

const gitOut = async (cwd: string, args: string[]): Promise<string> => (await execa("git", args, { cwd })).stdout;

/**
 * Makes `dir` a git repository of its own when it is not one. The joint folder and the reviewers' checkouts live
 * inside the project folder's repository (under its ignored `.graph-execution/`): an agent that commits in its
 * current directory would otherwise commit into the project. The real work is in `repos/<name>`, which it ignores.
 */
async function initSentinel(dir: string): Promise<void> {
  if (existsSync(path.join(dir, ".git"))) return;
  await mkdir(dir, { recursive: true });
  await execa("git", ["init", "-q"], { cwd: dir });
  for (const [key, value] of [
    ["user.name", "graph-execution"],
    ["user.email", "graph-execution@localhost"],
    ["commit.gpgsign", "false"],
  ] as const) {
    await execa("git", ["config", key, value], { cwd: dir });
  }
  await mkdir(path.join(dir, ".git", "info"), { recursive: true });
  await writeFile(path.join(dir, ".git", "info", "exclude"), "/repos/\n");
}

/** The review workspace over every repo's joint worktree: paths going out carry the repo name, heads are joint heads. */
export function jointWorkspace(o: JointWorkspaceOptions): ReviewWorkspace {
  const { repos } = o;
  const names = repos.map((r) => r.name);
  const shasOf = (head: string): Record<string, string> => {
    const parsed = parseHeads(head);
    if (!parsed || repos.some((r) => parsed[r.name] === undefined)) throw new Error(`not a joint head: ${head}`);
    return parsed;
  };
  /** The unprefixed paths of `files` per repo name. */
  const byRepo = (files: readonly string[]): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const file of files) {
      const split = splitPrefixed(file, names);
      if (split) out.set(split.name, [...(out.get(split.name) ?? []), split.path]);
    }
    return out;
  };
  const head = async (): Promise<string> => {
    const heads: Record<string, string> = {};
    for (const r of repos) heads[r.name] = await currentHead(r.dir);
    return formatHeads(heads);
  };
  const note = [
    `This change spans several git repositories, checked out under \`repos/<name>/\` of the current directory: ${names.join(", ")}. The current directory itself is not one of them.`,
    `- Paths in the diff, the findings and the review comments start with the repo name: \`${names[0]}/src/x.ts\` is the file \`repos/${names[0]}/src/x.ts\`.`,
    `- Each repo is its own git repository on branch ${o.branch}. To commit, commit inside each repo you changed (\`cd repos/${names[0]} && git add -A && git commit -m "..."\`), never in the current directory.`,
    "- Each repo has its own validation commands; run them from inside that repo.",
    ...(o.projectDir
      ? [
          `- Each repo's change was built from the task files in \`${path.join(o.projectDir, "tasks", "<name>")}\` (one folder per changed repo); the tasks folder named elsewhere in this prompt holds only the joint test plan.`,
        ]
      : []),
  ].join("\n");

  return {
    dir: jointDirOf(o.suiteDir),
    label: `${o.branch} in ${names.join(", ")}`,
    base: formatHeads(Object.fromEntries(repos.map((r) => [r.name, r.startingCommit]))),
    head,
    async diff(files) {
      const selected = files === undefined ? undefined : byRepo(files);
      const parts: string[] = [];
      for (const r of repos) {
        const own = selected?.get(r.name);
        if (selected && !own) continue;
        const text = await gitOut(r.dir, [
          "diff",
          `--src-prefix=a/${r.name}/`,
          `--dst-prefix=b/${r.name}/`,
          `${r.startingCommit}..HEAD`,
          ...(own ? ["--", ...own] : []),
        ]);
        if (text.trim() !== "") parts.push(text);
      }
      return parts.join("\n");
    },
    async changedFiles() {
      const out: string[] = [];
      for (const r of repos) {
        const listed = await gitOut(r.dir, ["diff", "--name-only", `${r.startingCommit}..HEAD`]);
        out.push(...listed.split("\n").filter(Boolean).map((f) => prefixPath(r.name, f)));
      }
      return out;
    },
    async repoFiles(files) {
      const out: Record<string, string> = {};
      for (const file of files) {
        const texts: string[] = [];
        for (const r of repos) {
          const text = await readOptional(path.join(r.dir, file));
          if (text !== undefined) texts.push(`## ${r.name}\n\n${text.trimEnd()}`);
        }
        if (texts.length > 0) out[file] = texts.join("\n\n");
      }
      return out;
    },
    // Forward slashes on purpose: prompt text, and valid in both `sh` and `cmd`.
    checks: repos.flatMap((r) => r.validate.map((c) => `cd repos/${r.name} && ${c}`)),
    async validate(signal) {
      const results: JointValidation[] = [];
      const failures: { name: string; command: string; exitCode: number | undefined; output: string }[] = [];
      // Every repo is validated, also after a failing one: the fixer gets all failures at once.
      for (const r of repos) {
        const res: CommandsResult =
          r.validate.length === 0 ? { ok: true } : await runCommands(r.validate, r.dir, signal, { parallel: r.validateParallel });
        const at = new Date().toISOString();
        if (res.ok) results.push({ repo: r.name, ok: true, commands: r.validate.length, at });
        else {
          failures.push({ name: r.name, command: res.command, exitCode: res.exitCode, output: res.output });
          results.push({
            repo: r.name,
            ok: false,
            commands: r.validate.length,
            command: res.command,
            ...(res.exitCode !== undefined ? { exitCode: res.exitCode } : {}),
            at,
          });
        }
      }
      // An interrupted validation says nothing about the repos.
      if (!signal.aborted) await o.onValidation?.(results);
      if (failures.length === 0) return { ok: true };
      return {
        ok: false,
        command: failures.map((f) => `${f.name}: ${f.command}`).join(", "),
        exitCode: failures[0]!.exitCode,
        output: failures
          .map((f) => `## ${f.name}: $ ${f.command} (exit code ${f.exitCode ?? "none"})\n${f.output.trimEnd()}`)
          .join("\n\n"),
      };
    },
    async dirty() {
      const out: string[] = [];
      for (const r of repos) out.push(...(await dirtyPaths(r.dir)).map((f) => prefixPath(r.name, f)));
      return out;
    },
    async commitLeftovers(message, preexisting) {
      const pre = byRepo(preexisting);
      let any = false;
      for (const r of repos) {
        if (await commitLeftovers(r.dir, message, pre.get(r.name) ?? [])) any = true;
      }
      return any;
    },
    async hasNewCommit(since) {
      const shas = shasOf(since);
      for (const r of repos) {
        if (await hasNewCommit(r.dir, shas[r.name]!)) return true;
      }
      return false;
    },
    async resetTo(to) {
      const shas = shasOf(to);
      for (const r of repos) await resetHard(r.dir, shas[r.name]!);
    },
    async messages(from, to) {
      const a = shasOf(from);
      const b = shasOf(to);
      const parts: string[] = [];
      for (const r of repos) {
        if (a[r.name] === b[r.name]) continue;
        const text = (await gitOut(r.dir, ["log", "--format=%B", `${a[r.name]}..${b[r.name]}`])).trim();
        parts.push(`[${r.name}]\n${text}`);
      }
      return parts.join("\n\n");
    },
    async addCheckout(dir, at) {
      const shas = shasOf(at);
      await mkdir(path.join(dir, "repos"), { recursive: true });
      await initSentinel(dir);
      for (const r of repos) await addDetachedWorktree(r.path, path.join(dir, "repos", r.name), shas[r.name]!);
    },
    async removeCheckout(dir) {
      for (const r of repos) await removeWorktreeIfPresent(r.path, path.join(dir, "repos", r.name));
      await rm(dir, { recursive: true, force: true, ...RM_RETRY });
    },
    // A glob matches a file with its repo prefix (`api/src/**`) or without it (`src/**`), so a repo's own globs still work.
    matchFiles(files, globs) {
      const positive = globs.filter((g) => !g.startsWith("!"));
      const negative = globs.filter((g) => g.startsWith("!"));
      return files.filter((file) => {
        const forms = [file, splitPrefixed(file, names)?.path].filter((f): f is string => f !== undefined);
        const selected = positive.length === 0 || matchFiles(forms, positive).length > 0;
        return selected && (negative.length === 0 || matchFiles(forms, negative).length === forms.length);
      });
    },
    note,
    ...(o.hasTestPlan ? {} : { noPlanReason: "the project has no test-plan.json" }),
  };
}

export interface JointRange {
  name: string;
  repo: string;
  from: string;
  to: string;
}

/** `rangeChanges` of each range with paths prefixed `<name>/`, sorted by path. */
export async function jointRangeChanges(ranges: readonly JointRange[]): Promise<ChangedFile[]> {
  const out: ChangedFile[] = [];
  for (const r of ranges) {
    for (const c of await rangeChanges(r.repo, r.from, r.to)) out.push({ ...c, path: prefixPath(r.name, c.path) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Creates (or keeps, on a resume) every joint worktree on `branch` and the sentinel repo at jointDirOf(suiteDir). */
export async function addJointWorktrees(
  suiteDir: string,
  branch: string,
  repos: readonly { name: string; path: string }[],
): Promise<void> {
  await initSentinel(jointDirOf(suiteDir));
  for (const repo of repos) {
    const dir = jointRepoDir(suiteDir, repo.name);
    if (existsSync(path.join(dir, ".git"))) continue;
    await mkdir(path.dirname(dir), { recursive: true });
    // What a stopped process left half-created, on disk or in the repo's worktree list.
    await removeWorktreeIfPresent(repo.path, dir);
    await addWorktree(repo.path, dir, branch);
  }
}

export async function removeJointWorktrees(suiteDir: string, repos: readonly { name: string; path: string }[]): Promise<void> {
  for (const repo of repos) await removeWorktreeIfPresent(repo.path, jointRepoDir(suiteDir, repo.name));
  await rm(jointDirOf(suiteDir), { recursive: true, force: true, ...RM_RETRY });
}

/** Writes <suiteDir>/joint/spec.md and <suiteDir>/joint/tasks/test-plan.json (a copy of the project's, removed when it has none). */
export async function buildJointInputs(
  suiteDir: string,
  project: { dir: string; contract: string },
  repos: readonly { name: string }[],
): Promise<{ specPath: string; tasksDir: string; hasTestPlan: boolean }> {
  const dir = path.join(suiteDir, "joint");
  const tasksDir = path.join(dir, "tasks");
  await mkdir(tasksDir, { recursive: true });
  const parts = [`# Contract\n\n${(await readFile(project.contract, "utf8")).trimEnd()}`];
  for (const repo of repos) {
    const spec = await readOptional(path.join(project.dir, "specs", `${repo.name}.md`));
    parts.push(`# Repo ${repo.name}\n\n${spec?.trimEnd() ?? "(no change planned in this repo; it is checked out for reference)"}`);
  }
  const specPath = path.join(dir, "spec.md");
  await writeFile(specPath, `${parts.join("\n\n")}\n`);

  const planFile = path.join(tasksDir, TEST_PLAN_FILE);
  const source = path.join(project.dir, TEST_PLAN_FILE);
  const hasTestPlan = existsSync(source);
  if (hasTestPlan) await copyFile(source, planFile);
  else await rm(planFile, { force: true });
  return { specPath, tasksDir, hasTestPlan };
}

/**
 * The joint phase across every repo on `suite/<rid>`: each repo's validation, then (with `e2eReview`) the reviewers,
 * the tester and the fixer over all repos at once, then the human review. Safe to run again on a resume.
 */
export async function jointPhase(ctx: JointContext): Promise<JointResult> {
  const { store, suiteDir, log, project } = ctx;
  const state = store.state;
  const suiteRepos = state.repos;
  if (!suiteRepos || suiteRepos.length === 0) throw new Error("the joint phase needs a multi-repo suite: suite.json has no repos");
  const branch = suiteBranchOf(ctx.suiteId);
  // The project folder's config; not `checkEnvironment`: the project folder gets no commits and needs no git identity.
  const config = await loadConfig(project.dir);
  const provider = await getProvider(state.provider, project.dir);

  await addJointWorktrees(suiteDir, branch, suiteRepos);
  if (!state.joint) {
    // Only the first time: a resume keeps the base from before the joint fixer's commits.
    const base: Record<string, string> = {};
    for (const r of suiteRepos) base[r.name] = (await resolveRef(r.path, `refs/heads/${branch}`)) ?? r.startingCommit;
    await store.update((s) => {
      s.joint = { base, validation: [] };
    });
  }

  const repos: JointRepo[] = [];
  const setup: string[] = [];
  for (const r of suiteRepos) {
    const own = await loadConfig(r.path);
    repos.push({
      name: r.name,
      path: r.path,
      startingCommit: r.startingCommit,
      dir: jointRepoDir(suiteDir, r.name),
      validate: own.validate,
      validateParallel: own.validateParallel,
    });
    // Run in each reviewer's checkout, whose layout has `repos/<name>`.
    setup.push(...own.setup.map((c) => `cd repos/${r.name} && ${c}`));
  }
  const { specPath, tasksDir, hasTestPlan } = await buildJointInputs(suiteDir, project, suiteRepos);
  const ws = jointWorkspace({
    suiteDir,
    branch,
    repos,
    hasTestPlan,
    projectDir: project.dir,
    onValidation: (results) =>
      store.update((s) => {
        if (s.joint) s.joint.validation = results;
      }),
  });

  if (state.humanReview && !ctx.reviewHub) log("humanReview needs the web view; applying without a human review");
  // The joint agents' full output goes to logs/<label>.log, like in a run.
  const output = new RunEmitter();
  const stopLogs = writeAgentLogs(output, path.join(suiteDir, "logs"));
  try {
    const wrap = (p: Provider): Provider =>
      teeOutput(
        watchIdle(
          watchLoops(trackProcesses(p, suiteDir), config.loopDetection, (label, why) => log(`[${label}] stopped: ${why}; retrying`)),
          config.idleTimeoutMinutes,
          (label, why) => log(`[${label}] stopped: ${why}; retrying`),
        ),
        output,
      );
    const reviewers = await readRunReviewers(suiteDir);
    const providers: Record<string, Provider> = {};
    for (const name of new Set(reviewers.flatMap((r) => (r.provider && r.provider !== state.provider ? [r.provider] : [])))) {
      providers[name] = wrap(await getProvider(name, project.dir));
    }
    const hub = ctx.reviewHub;
    // No `reviewFiles`: the reviewers get the whole combined diff, current after every fix pass.
    const result = await runReviewPhase({
      provider: wrap(provider),
      providers,
      reviewers,
      config: { ...config, validate: ws.checks.slice(), setup },
      repo: project.dir,
      runDir: suiteDir,
      integrationWorktree: ws.dir,
      integrationBranch: branch,
      startingCommit: ws.base,
      specPath,
      tasksDir,
      signal: ctx.signal ?? new AbortController().signal,
      hint: "graph-execution suite --resume",
      ...(state.model ? { model: state.model } : {}),
      log,
      ...(ctx.reviewEvents ? { events: ctx.reviewEvents } : {}),
      ...(state.humanReview && hub ? { human: { wait: () => hub.waitReview() } } : {}),
      withLock: createMergeLock(),
      validateOnly: !config.e2eReview,
      workspace: ws,
      progress: state.review ?? initialReviewState(),
      onProgress: (progress) =>
        store.update((s) => {
          s.review = structuredClone(progress);
        }),
    });
    if (result.human?.decision === "drop") return { ok: true, exitCode: result.exitCode, keep: "dropped in human review" };
    // An apply the human forced goes on despite open findings.
    if (result.exitCode !== EXIT_SUCCESS && !result.human) return { ok: false, exitCode: result.exitCode };
    if (codeReviewSkipped(result.reports)) return { ok: true, exitCode: EXIT_SUCCESS, keep: "code review not performed" };
    return { ok: true, exitCode: EXIT_SUCCESS };
  } finally {
    stopLogs();
  }
}
