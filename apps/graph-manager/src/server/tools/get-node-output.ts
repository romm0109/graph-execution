// `get_node_output` (docs/prd/agent-supervisor.md, KAN-91 #10): what one node of a run produced — its status and the
// tail of its agent log under `<runDir>/logs/`.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { BUILTIN_REVIEWERS, parseReviewers, RUN_REVIEWERS_FILE, type Reviewer } from "graph-execution/api";
import { z } from "zod";
import { runDetail, type TaskRow } from "../runs.js";
import type { CachedNode, CachedView } from "../viewcache.js";
import { fenced, isToolResult, readTailLines, requireWorkspace, runDirOrError, workspaceRel } from "./run-helpers.js";
import { defineTool } from "./types.js";

const input = z.object({
  runId: z.string().min(1).describe("The run id"),
  node: z.string().min(1).describe("A task id, or a review node: @reviewer, @tester, @fixer, @gate-fixer, @gate, @merge, @<reviewer id>"),
  lines: z.number().int().min(1).max(2000).optional().describe("How many log lines from the end (default 200)"),
});

/** The base of an agent log's file name; mirrors `logFileName` in packages/graph-execution/src/ui/store.ts (without `.log`). */
const logBase = (label: string): string => label.replace(/[^\w.-]+/g, "-");
/** Mirrors `sanitize` in packages/graph-execution/src/agents/summarizer.ts (failure summaries' file names). */
const sanitize = (id: string): string => id.replace(/[^\w.-]+/g, "-").replace(/^-+/, "");
/** Mirrors `reviewerNode` in packages/graph-execution/src/review/reviewers.ts. */
const reviewerNode = (id: string): string => (id === "code" ? "@reviewer" : `@${id}`);
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const VALIDATION_TAIL = 50;

type Known =
  | { kind: "task"; id: string; title: string }
  | { kind: "gate" | "gate-fixer" | "fixer" | "merge"; id: string; title: string }
  | { kind: "reviewer"; id: string; title: string; reviewer: Reviewer };

async function runReviewers(runDir: string): Promise<Reviewer[]> {
  const file = path.join(runDir, RUN_REVIEWERS_FILE);
  try {
    return parseReviewers(JSON.parse(await readFile(file, "utf8")), file).filter((r) => r.enabled);
  } catch {
    return BUILTIN_REVIEWERS.map((r) => ({ ...r }));
  }
}

/** The run's log files (names only); empty when `logs/` is missing. */
async function logFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

const numbers = (name: string): number[] => (name.match(/\d+/g) ?? []).map(Number);

/** Newest by mtime; ties: the larger round numbers. */
async function newest(dir: string, names: string[]): Promise<string | undefined> {
  const withTime = await Promise.all(
    names.map(async (n) => {
      try {
        return { n, t: (await stat(path.join(dir, n))).mtimeMs };
      } catch {
        return { n, t: -1 };
      }
    }),
  );
  withTime.sort((a, b) => {
    if (b.t !== a.t) return b.t - a.t;
    const na = numbers(a.n);
    const nb = numbers(b.n);
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
      const d = (nb[i] ?? -1) - (na[i] ?? -1);
      if (d !== 0) return d;
    }
    return a.n < b.n ? -1 : 1;
  });
  return withTime[0]?.n;
}

/** The pattern of a pipeline node's log files. */
function pipelinePattern(k: Known): RegExp | undefined {
  switch (k.kind) {
    case "fixer":
      return /^fix-r([1-9]\d*)(-v\d+)?\.log$/;
    case "gate-fixer":
      return /^fix-r0-v\d+\.log$/;
    case "gate":
      return /^review-validate(-\d+)?\.log$/;
    case "reviewer":
      return new RegExp(`^${escape(logBase(k.reviewer.id))}-r\\d+\\.log$`);
    default:
      return undefined;
  }
}

function viewNode(view: CachedView | undefined, k: Known): CachedNode | undefined {
  if (!view) return undefined;
  switch (k.kind) {
    case "gate":
      return view.gate;
    case "merge":
      return view.merge;
    case "fixer":
      return view.agents.fixer;
    case "gate-fixer":
      return view.agents.gateFixer;
    case "reviewer":
      return view.agents[k.reviewer.id === "code" ? "reviewer" : k.reviewer.id];
    default:
      return view.nodes[k.id];
  }
}

/** `summary: <cause> <why>` from the newest parsable failure summary of the node; undefined on any problem. */
async function latestSummary(runDir: string, node: string): Promise<string | undefined> {
  const dir = path.join(runDir, "summaries");
  const re = new RegExp(`^${escape(sanitize(node))}-(\\d+)\\.json$`);
  const names = (await logFiles(dir))
    .map((n) => ({ n, m: re.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => Number(b.m[1]) - Number(a.m[1]));
  for (const { n } of names) {
    try {
      const raw = JSON.parse(await readFile(path.join(dir, n), "utf8")) as { cause?: unknown; why?: unknown };
      if (typeof raw.cause === "string" && typeof raw.why === "string") return `summary: ${raw.cause} ${raw.why}`.trim();
    } catch {
      // skip a broken summary
    }
  }
  return undefined;
}

export const getNodeOutputTool = defineTool({
  name: "get_node_output",
  description:
    "Show what one node of a graph-execution run produced: a task's (or review node's) status, attempts and error, then the tail of its agent log.",
  input,
  async run(i, tc) {
    const ws = requireWorkspace(tc);
    if (isToolResult(ws)) return ws;
    const runDir = await runDirOrError(ws, i.runId);
    if (typeof runDir !== "string") return runDir;
    const detail = await runDetail(ws, i.runId, tc.ctx.config.dataDir);
    if (detail?.summary.type === "suite") return { isError: true, text: `run ${i.runId} is a suite; get_node_output works on runs` };
    const state = detail?.state;
    if (!detail || !state) return { isError: true, text: `run ${i.runId} has no state.json` };

    const rows = new Map<string, TaskRow>((detail.tasks ?? []).map((r) => [r.id, r]));
    const taskIds = detail.tasks && detail.tasks.length > 0 ? detail.tasks.map((r) => r.id) : Object.keys(state.tasks);
    const known: Known[] = [
      ...taskIds.map((id): Known => ({ kind: "task", id, title: rows.get(id)?.title ?? id })),
      { kind: "gate", id: "@gate", title: "validation" },
      { kind: "gate-fixer", id: "@gate-fixer", title: "validation fixer" },
      ...(await runReviewers(runDir)).map((r): Known => ({ kind: "reviewer", id: reviewerNode(r.id), title: r.name, reviewer: r })),
      { kind: "fixer", id: "@fixer", title: "fixer" },
      { kind: "merge", id: "@merge", title: "apply" },
    ];
    const k = known.find((n) => n.id === i.node);
    if (!k) return { isError: true, text: `unknown node ${i.node} in run ${i.runId}; nodes: ${known.map((n) => n.id).join(", ")}` };

    const out: string[] = [`Node ${k.id} of run ${i.runId} (${k.title})`];
    const vn = viewNode(detail.view, k);
    if (k.kind === "task") {
      const row = rows.get(k.id);
      const st = state.tasks[k.id];
      out.push(`status: ${row?.status ?? st?.status ?? vn?.status ?? "pending"}, attempts: ${row?.attempts ?? st?.attempts ?? vn?.attempts ?? 0}`);
      const error = row?.error ?? vn?.error;
      if (error) out.push(`error: ${error}`);
    } else if (vn) {
      const attempts = vn.attempts ?? vn.attempt;
      out.push(`status: ${vn.status}${attempts !== undefined ? `, attempts: ${attempts}` : ""}`);
      if (vn.error) out.push(`error: ${vn.error}`);
    } else {
      out.push("status: unknown (no cached view of this run)");
    }
    const summary = await latestSummary(runDir, k.id);
    if (summary) out.push(summary);
    if (k.kind === "merge" && detail.view?.summary?.merge?.reason) out.push(`apply: ${detail.view.summary.merge.reason}`);

    const logsDir = path.join(runDir, "logs");
    const files = await logFiles(logsDir);
    const rel = (name: string) => workspaceRel(ws, path.join(logsDir, name));
    let main: string | undefined;
    let validation: string | undefined;
    let matching: string[];
    if (k.kind === "task") {
      const base = logBase(k.id);
      const validateRe = new RegExp(`^${escape(base)}-validate-\\d+\\.log$`);
      const mainName = `${base}.log`;
      const resolver = `task-${base}-merge-resolver.log`;
      const validates = files.filter((f) => validateRe.test(f));
      matching = files.filter((f) => f === mainName || f === resolver || validateRe.test(f));
      if (files.includes(mainName)) main = mainName;
      validation = await newest(logsDir, validates);
    } else {
      const re = pipelinePattern(k);
      matching = re ? files.filter((f) => re.test(f)) : [];
      main = await newest(logsDir, matching);
    }

    out.push("");
    const n = i.lines ?? 200;
    const tail = main === undefined ? undefined : await readTailLines(path.join(logsDir, main), n);
    if (main === undefined || tail === undefined) {
      out.push(`no agent log for ${k.id} yet`);
    } else {
      const count = tail === "" ? 0 : tail.split("\n").length;
      out.push(`${k.kind === "gate" ? "validation log" : "agent log"} ${rel(main)} (last ${count} lines):`, fenced(tail));
    }
    if (validation !== undefined) {
      const vtail = await readTailLines(path.join(logsDir, validation), VALIDATION_TAIL);
      if (vtail !== undefined) out.push(`validation output ${rel(validation)}:`, fenced(vtail));
    }
    const others = matching.filter((f) => f !== main && f !== validation).sort();
    if (others.length > 0) out.push(`other logs: ${others.map(rel).join(", ")}`);
    return { text: out.join("\n") };
  },
});
