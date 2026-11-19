import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { execa } from "execa";
import { planSpecRel, planTasksRel, type RunState } from "graph-execution/api";
import type { AppContext } from "../app.js";
import { isRunId, readRunStateOf, runDirOf, taskTitle } from "../runs.js";
import { resolveWorkspace, type Workspace } from "../workspaces.js";
import { MAX_SPEC_BYTES } from "./specs.js";

/** A plan name written by an agent: only this form is used in paths and git arguments. */
const PLAN_NAME = /^[a-z0-9][a-z0-9-]{0,99}$/;
const SPEC_TOO_LARGE = "spec is larger than 1 MiB";

export interface RunPlanBody {
  name: string;
  spec: { path: string; title: string; text: string } | null;
  specError?: string;
  tasks: { id: string; title: string }[];
  refs: { ref: string; url?: string; title?: string }[];
  questions: { ref?: string; questions: string[] }[];
  dropped: string[];
  feedback: string[];
}

async function git(ws: Workspace, args: string[]): Promise<string | undefined> {
  try {
    const res = await execa("git", args, {
      cwd: ws.path,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      reject: false,
      stdin: "ignore",
      timeout: 10_000,
      maxBuffer: 4 * MAX_SPEC_BYTES,
    });
    return res.exitCode === 0 ? String(res.stdout ?? "") : undefined;
  } catch {
    return undefined;
  }
}

/** A plan file's text: tooLarge when it exceeds the cap, undefined when it can't be read. */
type Read = { text: string } | { tooLarge: true } | undefined;

/**
 * `p` (absolute, or relative to the workspace) when it resolves, symlinks followed, inside the workspace; else
 * undefined. The paths come from state.json and from the worktree, which agents can write: never read outside.
 */
async function inside(ws: Workspace, p: string): Promise<string | undefined> {
  if (p.includes("\0")) return undefined;
  try {
    const [real, root] = await Promise.all([realpath(path.resolve(ws.path, p)), realpath(ws.path)]);
    return real === root || real.startsWith(root + path.sep) ? real : undefined;
  } catch {
    return undefined;
  }
}

async function readFileCapped(ws: Workspace, p: string): Promise<Read> {
  const file = await inside(ws, p);
  if (file === undefined) return undefined;
  try {
    const st = await stat(file);
    if (!st.isFile()) return undefined;
    if (st.size > MAX_SPEC_BYTES) return { tooLarge: true };
    return { text: await readFile(file, "utf8") };
  } catch {
    return undefined;
  }
}

/**
 * Where the planned files are, in order: the integration branch, the integration worktree, then the checkout (once the
 * run is applied). `branch` is undefined when it is not a safe git revision.
 */
class PlanSource {
  constructor(
    private readonly ws: Workspace,
    private readonly branch: string | undefined,
    private readonly worktree: string,
  ) {}

  private wtPath(rel: string): string {
    return path.join(this.worktree, ...rel.split("/"));
  }

  async readSpec(rel: string, checkoutPath: string | undefined): Promise<Read> {
    if (this.branch) {
      const text = await git(this.ws, ["show", `${this.branch}:${rel}`]);
      if (text !== undefined) return Buffer.byteLength(text) > MAX_SPEC_BYTES ? { tooLarge: true } : { text };
    }
    const wt = await readFileCapped(this.ws, this.wtPath(rel));
    if (wt) return wt;
    return checkoutPath ? readFileCapped(this.ws, checkoutPath) : undefined;
  }

  /** The task files of the plan: `[fileName, text | undefined]`, without `test-plan.json`. */
  async readTasks(rel: string, checkoutDir: string | undefined): Promise<[string, string | undefined][] | undefined> {
    const isTask = (n: string) => n.endsWith(".json") && n !== "test-plan.json";
    if (this.branch) {
      const out = await git(this.ws, ["ls-tree", "--name-only", this.branch, `${rel}/`]);
      if (out !== undefined && out.trim() !== "") {
        const names = out
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "")
          .map((l) => l.slice(l.lastIndexOf("/") + 1))
          .filter(isTask);
        return Promise.all(names.map(async (n) => [n, await git(this.ws, ["show", `${this.branch}:${rel}/${n}`])] as [string, string | undefined]));
      }
    }
    for (const d of [this.wtPath(rel), checkoutDir]) {
      const dir = d === undefined ? undefined : await inside(this.ws, d);
      if (dir === undefined) continue;
      let names: string[];
      try {
        names = (await readdir(dir)).filter(isTask);
      } catch {
        continue;
      }
      return Promise.all(
        names.map(async (n) => {
          const r = await readFileCapped(this.ws, path.join(dir, n));
          return [n, r && "text" in r ? r.text : undefined] as [string, string | undefined];
        }),
      );
    }
    return undefined;
  }
}

function taskOf(fileName: string, text: string | undefined): { id: string; title: string } {
  const fallback = fileName.slice(0, -".json".length);
  if (text === undefined) return { id: fallback, title: fallback };
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : fallback;
    const content = typeof raw.content === "string" ? raw.content : "";
    return { id, title: taskTitle(content) ?? id };
  } catch {
    return { id: fallback, title: fallback };
  }
}

/** The planned spec and tasks of a run, or undefined when it has no (valid) plan name. */
export async function readRunPlan(ws: Workspace, runId: string, state: RunState): Promise<RunPlanBody | undefined> {
  const plan = state.plan;
  const name = plan?.name;
  if (!plan || name === undefined || !PLAN_NAME.test(name)) return undefined;
  const branch = state.integrationBranch && !state.integrationBranch.startsWith("-") ? state.integrationBranch : undefined;
  const src = new PlanSource(ws, branch, path.join(runDirOf(ws, runId), "worktrees", "integration"));
  const specRel = planSpecRel(name);
  const tasksRel = planTasksRel(name);

  const [specRead, files] = await Promise.all([src.readSpec(specRel, state.specPath), src.readTasks(tasksRel, state.tasksDir)]);
  const body: RunPlanBody = {
    name,
    spec: null,
    tasks: (files ?? []).map(([n, t]) => taskOf(n, t)).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })),
    refs: plan.refs ?? [],
    questions: plan.questions ?? [],
    dropped: plan.dropped ?? [],
    feedback: plan.feedback ?? [],
  };
  if (specRead && "tooLarge" in specRead) body.specError = SPEC_TOO_LARGE;
  else if (specRead) body.spec = { path: specRel, title: taskTitle(specRead.text) ?? name, text: specRead.text };
  return body;
}

export async function planRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Params: { ws: string; runId: string } }>("/api/runs/:ws/:runId/plan", async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!isRunId(req.params.runId)) return reply.code(400).send({ error: "invalid run id" });
    const ws = resolveWorkspace(ctx.config.workspacesDir, req.params.ws);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    const state = await readRunStateOf(ws, req.params.runId);
    if (!state) return reply.code(404).send({ error: "unknown run" });
    const body = await readRunPlan(ws, req.params.runId, state);
    if (!body) return reply.code(404).send({ error: "the run has no plan" });
    return body;
  });
}
