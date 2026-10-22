import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { rangeChanges, rangeFileDiff, summarizeChanges, worktreeChanges } from "../git/git.js";
import type { RunEmitter } from "./events.js";

/** How often a running agent's worktree is re-diffed. */
export const CHANGES_INTERVAL_MS = 2000;

export interface FileDiff {
  path: string;
  /** Unified diff text, possibly cut at DIFF_CAP_BYTES. */
  diff: string;
  truncated: boolean;
  binary: boolean;
}
export const DIFF_CAP_BYTES = 200 * 1024;

const gitRead = async (cwd: string, args: string[]): Promise<string> =>
  (await execa("git", ["--no-optional-locks", ...args], { cwd })).stdout;

export function capDiff(path: string, diff: string): FileDiff {
  if (Buffer.byteLength(diff) <= DIFF_CAP_BYTES) return { path, diff, truncated: false, binary: false };
  let cut = Buffer.from(diff).subarray(0, DIFF_CAP_BYTES).toString();
  // A multi-byte character split by the cut leaves a replacement character at the end.
  if (cut.endsWith("\uFFFD")) cut = cut.slice(0, -1);
  // Cut at a line boundary, unless that would drop most of the content (e.g. one huge line).
  const lineEnd = cut.lastIndexOf("\n") + 1;
  return { path, diff: lineEnd > cut.length / 2 ? cut.slice(0, lineEnd) : cut, truncated: true, binary: false };
}

/** The diff of one file between `base` and the worktree's current content; an untracked file shows as all added. */
export async function worktreeFileDiff(worktree: string, base: string, file: string): Promise<FileDiff> {
  const numstat = (await gitRead(worktree, ["diff", "--no-renames", "--numstat", base, "--", file])).trim();
  if (numstat.startsWith("-\t-")) return { path: file, diff: "", truncated: false, binary: true };
  if (numstat) return capDiff(file, await gitRead(worktree, ["diff", "--no-renames", base, "--", file]));
  const buf = await readFile(path.join(worktree, file));
  if (buf.subarray(0, 8000).includes(0)) return { path: file, diff: "", truncated: false, binary: true };
  const text = buf.toString();
  if (text === "") return { path: file, diff: "", truncated: false, binary: false };
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  const diff = `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
  return capDiff(file, diff);
}

export type FileLines = { lines: string[]; total: number } | "binary";

/** Lines [from, to] (1-based, inclusive) of file content; "binary" when there is a NUL byte in the first 8000 bytes. */
export function sliceLines(buf: Uint8Array, from: number, to: number): FileLines {
  if (buf.subarray(0, 8000).includes(0)) return "binary";
  const all = Buffer.from(buf).toString().split("\n");
  if (all[all.length - 1] === "") all.pop();
  return { lines: all.slice(from - 1, to).map((l) => l.replace(/\r$/, "")), total: all.length };
}

/** Lines [from, to] of `file` as committed at `ref`. Throws when the file is not there. */
export async function gitFileLines(repo: string, ref: string, file: string, from: number, to: number): Promise<FileLines> {
  const { stdout } = await execa("git", ["--no-optional-locks", "show", `${ref}:${file}`], { cwd: repo, encoding: "buffer" });
  return sliceLines(stdout, from, to);
}

interface Tracked {
  worktree: string;
  base: string;
  exclude: string[];
  timer?: NodeJS.Timeout;
  busy: boolean;
  running: boolean;
  /** JSON of the last `NodeChanges` emitted. */
  last?: string;
  /** Set once the node is finished: its diff is `base..to` in `repo`, whatever happens to the worktree. */
  range?: { repo: string; to: string };
  /** The refresh in flight, if any. */
  inflight?: Promise<void>;
}

/**
 * Re-diffs the worktree of each tracked node while its agent runs and emits `nodeChanges` when the stats change.
 * Read-only, and it never takes the merge lock.
 */
export class ChangeTracker {
  private readonly nodes = new Map<string, Tracked>();
  private readonly unsubscribe: (() => void)[];
  private readonly intervalMs: number;

  constructor(
    private readonly events: RunEmitter,
    opts: { intervalMs?: number } = {},
  ) {
    this.intervalMs = opts.intervalMs ?? CHANGES_INTERVAL_MS;
    this.unsubscribe = [
      events.on("changes:track", ({ nodeId, worktree, base, exclude }) => this.track(nodeId, worktree, base, exclude ?? [])),
      events.on("changes:stop", ({ nodeId, repo, to }) => void this.stop(nodeId, repo && to ? { repo, to } : undefined)),
      events.on("changes:reset", ({ nodeId }) => this.reset(nodeId)),
    ];
  }

  isTracked = (nodeId: string): boolean => this.nodes.has(nodeId);

  tracked(nodeId: string): { worktree: string; base: string; running: boolean } | undefined {
    const t = this.nodes.get(nodeId);
    return t && { worktree: t.worktree, base: t.base, running: t.running };
  }

  /** The diff of one file of a tracked node against its base; `undefined` when the node is not tracked or its worktree is gone. */
  async fileDiff(nodeId: string, file: string): Promise<FileDiff | undefined> {
    const t = this.nodes.get(nodeId);
    if (!t) return undefined;
    try {
      if (t.range) {
        const { repo, to } = t.range;
        const numstat = (await gitRead(repo, ["diff", "--no-renames", "--numstat", t.base, to, "--", file])).trim();
        if (numstat.startsWith("-\t-")) return { path: file, diff: "", truncated: false, binary: true };
        return capDiff(file, await rangeFileDiff(repo, t.base, to, file));
      }
      return await worktreeFileDiff(t.worktree, t.base, file);
    } catch {
      return undefined;
    }
  }

  /** Lines [from, to] (1-based, inclusive) of `file` at the node's head: the range's `to` commit, or the worktree file. */
  async fileLines(nodeId: string, file: string, from: number, to: number): Promise<FileLines | undefined> {
    const t = this.nodes.get(nodeId);
    if (!t) return undefined;
    try {
      if (t.range) return await gitFileLines(t.range.repo, t.range.to, file, from, to);
      return sliceLines(await readFile(path.join(t.worktree, file)), from, to);
    } catch {
      return undefined;
    }
  }

  /** Registers a finished node directly (after a resume) and emits its stats. */
  async seed(nodeId: string, repo: string, from: string, to: string): Promise<void> {
    clearInterval(this.nodes.get(nodeId)?.timer);
    const t: Tracked = { worktree: repo, base: from, exclude: [], busy: false, running: false, range: { repo, to } };
    this.nodes.set(nodeId, t);
    await this.refresh(nodeId, t);
  }

  dispose(): void {
    for (const t of this.nodes.values()) {
      clearInterval(t.timer);
      t.running = false;
    }
    for (const off of this.unsubscribe) off();
  }

  private track(nodeId: string, worktree: string, base: string, exclude: string[]): void {
    clearInterval(this.nodes.get(nodeId)?.timer);
    const t: Tracked = { worktree, base, exclude, busy: false, running: true };
    this.nodes.set(nodeId, t);
    void this.refresh(nodeId, t);
    t.timer = setInterval(() => void this.refresh(nodeId, t), this.intervalMs);
    t.timer.unref();
  }

  private reset(nodeId: string): void {
    clearInterval(this.nodes.get(nodeId)?.timer);
    this.nodes.delete(nodeId);
    this.events.emit("nodeChanges", { nodeId, changes: summarizeChanges([]) });
  }

  private async stop(nodeId: string, range?: { repo: string; to: string }): Promise<void> {
    const t = this.nodes.get(nodeId);
    if (!t) return;
    clearInterval(t.timer);
    t.timer = undefined;
    await t.inflight;
    if (range) t.range = range;
    await this.refresh(nodeId, t);
    t.running = false;
  }

  private refresh(nodeId: string, t: Tracked): Promise<void> {
    if (t.busy) return t.inflight ?? Promise.resolve();
    t.busy = true;
    t.inflight = (async () => {
      try {
        const files = t.range ? await rangeChanges(t.range.repo, t.base, t.range.to) : await worktreeChanges(t.worktree, t.base, t.exclude);
        const changes = summarizeChanges(files);
        const json = JSON.stringify(changes);
        // A newer `changes:track` for the node replaced this entry: its result is stale.
        if (json !== t.last && this.nodes.get(nodeId) === t) {
          t.last = json;
          this.events.emit("nodeChanges", { nodeId, changes });
        }
      } catch {
        // The worktree may be gone already; the view just keeps its last snapshot.
      } finally {
        t.busy = false;
        t.inflight = undefined;
      }
    })();
    return t.inflight;
  }
}
