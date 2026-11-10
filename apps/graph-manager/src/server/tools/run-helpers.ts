// Shared helpers of the run tools (list_runs, get_run_log, get_node_output, get_artifacts, cancel_run, resume_run).
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { stateSchema, type RunState } from "graph-execution/api";
import { upstreamPort, upstreamPost } from "../proxy.js";
import { isRunId, livePage, runDirOf, type LivePage } from "../runs.js";
import { waitingFailedTask } from "../supervisor.js";
import type { Workspace } from "../workspaces.js";
import type { ToolContext, ToolResult } from "./types.js";

export const NOT_IN_WORKSPACE = "this terminal is not inside a graph-manager workspace";

/** How much of a file `readTailLines` reads at most. */
const TAIL_BYTES = 4 * 1024 * 1024;

/** True for a ToolResult (has a string `text`), false for a Workspace or a string. */
export function isToolResult(v: unknown): v is ToolResult {
  return typeof v === "object" && v !== null && typeof (v as { text?: unknown }).text === "string";
}

/** The calling terminal's workspace, or the error result. */
export function requireWorkspace(tc: ToolContext): Workspace | ToolResult {
  return tc.workspace ?? { isError: true, text: NOT_IN_WORKSPACE };
}

/** `<ws>/.graph-execution/<runId>` when runId is a valid run id and that folder exists; else `unknown run <id>`. */
export async function runDirOrError(ws: Workspace, runId: string): Promise<string | ToolResult> {
  const unknown: ToolResult = { isError: true, text: `unknown run ${runId}` };
  // Checked before any path is built: an id like `../x` never reaches the filesystem.
  if (!isRunId(runId)) return unknown;
  const dir = runDirOf(ws, runId);
  try {
    return (await stat(dir)).isDirectory() ? dir : unknown;
  } catch {
    return unknown;
  }
}

/**
 * The last `lines` lines of a text file (trailing newline trimmed), or undefined when it is missing. Reads at most the
 * last 4 MiB; when the read starts inside the file, the partial first line is dropped.
 */
export async function readTailLines(file: string, lines: number): Promise<string | undefined> {
  let fh;
  try {
    fh = await open(file, "r");
  } catch {
    return undefined;
  }
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    let bytes = buf.subarray(0, bytesRead);
    if (start > 0) {
      const nl = bytes.indexOf(0x0a);
      if (nl !== -1 && nl < bytes.length - 1) bytes = bytes.subarray(nl + 1);
    }
    const text = bytes.toString("utf8").replace(/\r?\n$/, "");
    if (text === "") return "";
    return text.split("\n").slice(-lines).join("\n");
  } finally {
    await fh.close();
  }
}

/** `p` relative to the workspace with `/` separators ("." for the root); `p` unchanged when it is outside the workspace. */
export function workspaceRel(ws: Workspace, p: string): string {
  const rel = path.relative(ws.path, path.resolve(ws.path, p));
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return p;
  return rel.split(path.sep).join("/");
}

/** Escapes a Markdown table cell: `|` → `\|`, newlines → spaces. */
export function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** A Markdown table from a header row and rows of cells (cells passed through `cell`). */
export function table(head: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
  return [line(head), `| ${head.map(() => "---").join(" | ")} |`, ...rows.map(line)].join("\n");
}

/** A fenced block that cannot be closed by the text inside: a fence longer than any run of backticks in it, at least 3. */
export function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** Where to POST to a live run page: its sandbox's upstream, else 127.0.0.1:<port of its url>. */
export function pageTarget(page: LivePage | undefined): { host: string; port: number; hostPort?: number; token?: string } | undefined {
  if (!page) return undefined;
  if (page.upstream) return page.upstream;
  const port = upstreamPort(page.url);
  return port !== undefined ? { host: "127.0.0.1", port } : undefined;
}

async function readRunStateOf(runDir: string): Promise<RunState | undefined> {
  try {
    const parsed = stateSchema.safeParse(JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const CLOSE_TIMEOUT_MS = 5000;
const CLOSE_WAIT_MS = 10_000;

/**
 * Closes the page of a run that has stopped but whose engine keeps its page open (`--web`): after an abort, after its
 * end, or while it waits on a failed task for Retry, Merge or Close. Waits until the page is gone, so the run can be
 * resumed. A no-op when no page is live or the run is still working.
 */
export async function closeStoppedPage(runDir: string): Promise<void> {
  const page = await livePage(runDir);
  const target = pageTarget(page);
  if (!target) return;
  const state = await readRunStateOf(runDir);
  if (!state || (state.status === "running" && waitingFailedTask(state) === undefined)) return;
  try {
    const answer = await upstreamPost(target, "/close", CLOSE_TIMEOUT_MS);
    if (answer.status !== 200) return;
  } catch {
    return;
  }
  const until = Date.now() + CLOSE_WAIT_MS;
  while (Date.now() < until && (await livePage(runDir))) await new Promise((r) => setTimeout(r, 100));
}
