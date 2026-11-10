// `get_artifacts` (docs/prd/agent-supervisor.md, KAN-91 #11): the files a run changed (from git, between its starting
// commit and its result branch) and the run's own report files.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { RUNS_DIR } from "graph-execution/api";
import { z } from "zod";
import { runDetail } from "../runs.js";
import type { Workspace } from "../workspaces.js";
import { isToolResult, requireWorkspace, runDirOrError, table, workspaceRel } from "./run-helpers.js";
import { defineTool } from "./types.js";

const input = z.object({ runId: z.string().min(1).describe("The run id") });

/** Pathspec of everything but graph-execution's own folder (as in runs.ts). */
const PATHSPEC = ["--", ".", `:(exclude)${RUNS_DIR}`];
const MAX_ROWS = 500;

/** git in the workspace (as runs.ts's `git`); undefined when it fails. */
async function git(ws: Workspace, args: string[]): Promise<string | undefined> {
  try {
    const res = await execa("git", args, {
      cwd: ws.path,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      reject: false,
      stdin: "ignore",
      timeout: 10_000,
    });
    return res.exitCode === 0 ? String(res.stdout ?? "") : undefined;
  } catch {
    return undefined;
  }
}

const STATUS: Record<string, string> = { A: "added", M: "modified", D: "deleted", T: "type changed" };

/** path → `+a -d` / `binary`, from `--numstat` output. */
function numstatMap(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of out.split("\n")) {
    const [a, d, ...rest] = line.split("\t");
    if (a === undefined || d === undefined || rest.length === 0) continue;
    m.set(rest.join("\t"), a === "-" && d === "-" ? "binary" : `+${a} -${d}`);
  }
  return m;
}

/** The changed files between two commits; undefined when git fails. */
async function diffRows(ws: Workspace, from: string, to: string): Promise<string[][] | undefined> {
  const names = await git(ws, ["diff", "--no-renames", "--name-status", from, to, ...PATHSPEC]);
  const nums = await git(ws, ["diff", "--no-renames", "--numstat", from, to, ...PATHSPEC]);
  if (names === undefined || nums === undefined) return undefined;
  const counts = numstatMap(nums);
  const rows: string[][] = [];
  for (const line of names.split("\n")) {
    const [letter, ...rest] = line.split("\t");
    if (!letter || rest.length === 0) continue;
    const file = rest.join("\t");
    rows.push([file, STATUS[letter[0]!] ?? letter, counts.get(file) ?? ""]);
  }
  return rows;
}

/** The workspace's uncommitted changes; undefined when git fails. */
async function workingTreeRows(ws: Workspace): Promise<string[][] | undefined> {
  const status = await git(ws, ["status", "--porcelain", "--untracked-files=all", ...PATHSPEC]);
  if (status === undefined) return undefined;
  const counts = numstatMap((await git(ws, ["diff", "--numstat", "HEAD", ...PATHSPEC])) ?? "");
  const rows: string[][] = [];
  for (const line of status.split("\n")) {
    if (line.trim() === "") continue;
    const code = line.slice(0, 2);
    let file = line.slice(3);
    if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
    const arrow = file.indexOf(" -> ");
    if (arrow !== -1) file = file.slice(arrow + 4);
    const kind = code === "??" || code.includes("A") ? "added" : code.includes("D") ? "deleted" : "modified";
    rows.push([file, kind, code === "??" ? "+?" : (counts.get(file) ?? "")]);
  }
  return rows;
}

/** Every file under `dir`, recursive; empty when it is missing. */
async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

async function reportFiles(ws: Workspace, runDir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    if ((await readdir(runDir)).includes("run.log")) files.push(path.join(runDir, "run.log"));
  } catch {
    // no run folder listing
  }
  files.push(...(await walk(path.join(runDir, "reports"))));
  try {
    const summaries = path.join(runDir, "summaries");
    for (const e of await readdir(summaries, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".json")) files.push(path.join(summaries, e.name));
    }
  } catch {
    // no summaries
  }
  return files.map((f) => workspaceRel(ws, f)).sort();
}

export const getArtifactsTool = defineTool({
  name: "get_artifacts",
  description:
    "List the files a graph-execution run changed (path, status, +/-) between its starting commit and its result branch, and the run's report files.",
  input,
  async run(i, tc) {
    const ws = requireWorkspace(tc);
    if (isToolResult(ws)) return ws;
    const runDir = await runDirOrError(ws, i.runId);
    if (typeof runDir !== "string") return runDir;
    const detail = await runDetail(ws, i.runId, tc.ctx.config.dataDir);
    if (detail?.summary.type === "suite") return { isError: true, text: `run ${i.runId} is a suite; get_artifacts works on runs` };
    const state = detail?.state;
    if (!detail || !state) return { isError: true, text: `run ${i.runId} has no state.json` };
    const status = detail.summary.status;
    const b = state.integrationBranch;

    const out: string[] = [];
    if (status === "applied") {
      out.push(`Run ${i.runId} was applied to ${state.targetBranch ?? "the checkout"} as uncommitted changes. Files it changed (${state.startingCommit.slice(0, 7)}..${b}):`);
    } else if (status === "done") {
      out.push(`Run ${i.runId} is done; the result is on branch ${b}. Files it changed:`);
    } else {
      out.push(`Run ${i.runId} is ${status}: not finished, this is what is merged into ${b} so far. Files changed:`);
    }

    const head = (await git(ws, ["rev-parse", "--verify", "--quiet", `${b}^{commit}`]))?.trim();
    let rows: string[][] | undefined;
    if (head) {
      rows = await diffRows(ws, state.startingCommit, head);
      if (rows === undefined) out.push(`could not diff ${state.startingCommit}..${b} (git failed)`);
    } else if (status === "applied") {
      out.push(`(from the working tree: the result branch ${b} is gone; it may include your own uncommitted changes)`);
      rows = await workingTreeRows(ws);
      if (rows === undefined) out.push("could not read the working tree (git failed)");
    } else {
      out.push(`The result branch ${b} is gone; no changed files to show.`);
    }
    if (rows !== undefined) {
      if (rows.length === 0) out.push("No files changed.");
      else {
        out.push(table(["file", "status", "+/-"], rows.slice(0, MAX_ROWS)));
        if (rows.length > MAX_ROWS) out.push(`… and ${rows.length - MAX_ROWS} more files`);
      }
    }

    const reports = await reportFiles(ws, runDir);
    out.push("", "Report files:", ...(reports.length > 0 ? reports.map((r) => `- ${r}`) : ["none"]));
    return { text: out.join("\n") };
  },
});
