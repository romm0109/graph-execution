import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { isRepo, listBranches } from "../git/git.js";
import { RUNS_DIR } from "../launch/preflight.js";
import { lockHolder, type RunStatus, stateSchema } from "../state/state.js";
import { SUITE_FILE, parseSuiteState, type SuiteState, type SuiteStatus } from "../suite/state.js";

export type RunKind = "applied" | "done" | "unfinished" | "live";

export interface RunEntry {
  /** A suite is one entry: `id` is the `suite-<rid>` folder name and its feature runs are never listed separately. */
  type: "run" | "suite";
  id: string;
  dir: string;
  /** From state.json / suite.json; "unknown" when it is missing or invalid. */
  status: RunStatus | SuiteStatus | "unknown";
  /** live: a live process holds the lock; applied/done from the status; everything else is unfinished. */
  kind: RunKind;
  createdAt?: string;
  sizeBytes: number;
  /** `graph/<id>` if it exists, plus every `graph-task/<id>/*` branch. */
  branches: string[];
  /** The live lock holder. */
  pid?: number;
  /** Suites only: the feature run ids. */
  features: string[];
  /** Suites only: the names of all its repos, when it has more than one. */
  repoNames?: string[];
  /**
   * Multi-repo suites only: per repo other than the scanned home, its `suite/<rid>`, feature branches and the
   * worktrees checked out under the suite folder. `missing` when the repo's folder is gone or not a git repo.
   */
  repos?: { root: string; name: string; branches: string[]; worktrees: string[]; missing?: boolean }[];
}

/** Time-ordering key: `suite-<rid>` sorts by `<rid>`. */
const idTime = (id: string): string => (id.startsWith("suite-") ? id.slice("suite-".length) : id);
export const compareIds = (a: string, b: string): number => idTime(a).localeCompare(idTime(b)) || a.localeCompare(b);

export interface Scan {
  repo: string;
  runs: RunEntry[];
  /** Branches whose run folder no longer exists. */
  orphans: string[];
  /** Branches checked out in any worktree. */
  checkedOut: string[];
  /** Checked-out branches with the worktree path that holds them. */
  worktrees: { branch: string; path: string }[];
}

/** Recursive size of `dir`; symlinks are not followed and errors are ignored. */
async function dirSize(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const sizes = await Promise.all(
    entries.map(async (e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return dirSize(full);
      return (await lstat(full).catch(() => undefined))?.size ?? 0;
    }),
  );
  return sizes.reduce((a, b) => a + b, 0);
}

async function checkedOutWorktrees(repo: string): Promise<{ branch: string; path: string }[]> {
  const res = await execa("git", ["worktree", "list", "--porcelain"], { cwd: repo, reject: false });
  if (res.exitCode !== 0) return [];
  const out: { branch: string; path: string }[] = [];
  let current = "";
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch refs/heads/")) out.push({ branch: line.slice("branch refs/heads/".length).trim(), path: current });
  }
  return out;
}

/** The run id a `graph/*` or `graph-task/*` branch belongs to. */
function branchRunId(branch: string): string {
  return branch.startsWith("graph-task/") ? (branch.split("/")[1] ?? "") : branch.slice("graph/".length);
}

async function readRun(root: string, id: string, graphBranches: string[], taskBranches: string[]): Promise<RunEntry | undefined> {
  const dir = path.join(root, id);
  let raw: string;
  try {
    raw = await readFile(path.join(dir, "state.json"), "utf8");
  } catch {
    return undefined;
  }
  let state: ReturnType<typeof stateSchema.safeParse> | undefined;
  try {
    state = stateSchema.safeParse(JSON.parse(raw));
  } catch {
    state = undefined;
  }
  const parsed = state?.success ? state.data : undefined;
  const status = parsed ? (parsed.status ?? "unknown") : "unknown";
  const pid = await lockHolder(dir);
  const kind: RunKind = pid !== undefined ? "live" : status === "applied" || status === "done" ? status : "unfinished";
  const branches = [
    ...graphBranches.filter((b) => b === `graph/${id}`),
    ...taskBranches.filter((b) => b.startsWith(`graph-task/${id}/`)),
  ];
  return { type: "run", id, dir, status, kind, createdAt: parsed?.createdAt, sizeBytes: await dirSize(dir), branches, pid, features: [] };
}

async function readSuite(
  home: string,
  root: string,
  id: string,
  suiteBranches: string[],
  graphBranches: string[],
  taskBranches: string[],
): Promise<RunEntry | undefined> {
  const dir = path.join(root, id);
  let raw: string;
  try {
    raw = await readFile(path.join(dir, SUITE_FILE), "utf8");
  } catch {
    return undefined;
  }
  let state: SuiteState | undefined;
  try {
    state = parseSuiteState(JSON.parse(raw), dir);
  } catch {
    state = undefined;
  }
  const status = state?.status ?? "unknown";
  const pid = await lockHolder(dir);
  const kind: RunKind = pid !== undefined ? "live" : status === "applied" || status === "done" ? status : "unfinished";
  // An unreadable suite.json must not turn its feature branches into orphans: take the ids from the folders.
  const features = state
    ? state.features.map((f) => f.runId)
    : (await readdir(path.join(dir, "features"), { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name);
  const branches = [
    ...suiteBranches.filter((b) => b === `suite/${id.slice("suite-".length)}`),
    ...features.flatMap((f) => [
      ...graphBranches.filter((b) => b === `graph/${f}`),
      ...taskBranches.filter((b) => b.startsWith(`graph-task/${f}/`)),
    ]),
  ];
  const entry: RunEntry = { type: "suite", id, dir, status, kind, createdAt: state?.createdAt, sizeBytes: await dirSize(dir), branches, pid, features };
  if (state && state.repos.length > 1) {
    entry.repoNames = state.repos.map((r) => r.name);
    const rid = id.slice("suite-".length);
    const realDir = await realpath(dir).catch(() => dir);
    entry.repos = await Promise.all(
      state.repos
        .filter((r) => path.resolve(r.root) !== path.resolve(home))
        .map(async (r) => {
          if (!(await isRepo(r.root))) return { root: r.root, name: r.name, branches: [], worktrees: [], missing: true };
          const [suite, graph, task, wts] = await Promise.all([
            listBranches(r.root, "suite/"),
            listBranches(r.root, "graph/"),
            listBranches(r.root, "graph-task/"),
            checkedOutWorktrees(r.root),
          ]);
          const mine = state.features.filter((f) => f.repo === r.name).map((f) => f.runId);
          const under = async (p: string): Promise<boolean> => {
            const real = await realpath(p).catch(() => path.resolve(p));
            return real.startsWith(realDir + path.sep) || path.resolve(p).startsWith(dir + path.sep);
          };
          const worktrees: string[] = [];
          for (const w of wts) if (await under(w.path)) worktrees.push(w.path);
          return {
            root: r.root,
            name: r.name,
            branches: [
              ...suite.filter((b) => b === `suite/${rid}`),
              ...mine.flatMap((f) => [...graph.filter((b) => b === `graph/${f}`), ...task.filter((b) => b.startsWith(`graph-task/${f}/`))]),
            ],
            worktrees,
          };
        }),
    );
  }
  return entry;
}

/** Reads every run folder and every `graph/*` / `graph-task/*` branch. Pure data: nothing is printed or changed. */
export async function scan(repo: string): Promise<Scan> {
  const root = path.join(repo, RUNS_DIR);
  const inRepo = await isRepo(repo);
  const [dirents, graphBranches, taskBranches, suiteBranches, worktrees] = await Promise.all([
    readdir(root, { withFileTypes: true }).catch(() => []),
    inRepo ? listBranches(repo, "graph/") : [],
    inRepo ? listBranches(repo, "graph-task/") : [],
    inRepo ? listBranches(repo, "suite/") : [],
    inRepo ? checkedOutWorktrees(repo) : [],
  ]);
  const ids = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith("suite-") && !d.name.startsWith("_"))
    .map((d) => d.name)
    .sort();
  const suiteIds = dirents
    .filter((d) => d.isDirectory() && d.name.startsWith("suite-"))
    .map((d) => d.name)
    .sort();
  const runs = (
    await Promise.all([
      ...ids.map((id) => readRun(root, id, graphBranches, taskBranches)),
      ...suiteIds.map((id) => readSuite(repo, root, id, suiteBranches, graphBranches, taskBranches)),
    ])
  ).filter((r): r is RunEntry => r !== undefined);
  const known = new Set(runs.flatMap((r) => (r.type === "suite" ? r.features : [r.id])));
  const suiteFolders = new Set(runs.filter((r) => r.type === "suite").map((r) => r.id));
  // Pointer files: suites that live in another home but have features and a `suite/<rid>` branch here.
  const pointerDir = path.join(root, "_suites");
  for (const name of await readdir(pointerDir).catch(() => [] as string[])) {
    if (!name.endsWith(".json")) continue;
    try {
      const ptr = JSON.parse(await readFile(path.join(pointerDir, name), "utf8")) as { suiteDir?: unknown; features?: unknown };
      if (typeof ptr.suiteDir !== "string" || !(await lstat(path.join(ptr.suiteDir, SUITE_FILE)).catch(() => undefined))) continue;
      if (Array.isArray(ptr.features)) for (const f of ptr.features) if (typeof f === "string") known.add(f);
      suiteFolders.add(name.slice(0, -".json".length));
    } catch {
      // not valid JSON: ignored
    }
  }
  const orphans = [
    ...[...graphBranches, ...taskBranches].filter((b) => !known.has(branchRunId(b))),
    ...suiteBranches.filter((b) => !suiteFolders.has(`suite-${b.slice("suite/".length)}`)),
  ].sort();
  return { repo, runs, orphans, checkedOut: worktrees.map((w) => w.branch), worktrees };
}
