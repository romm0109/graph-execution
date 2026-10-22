import { rangeChanges, rangeFileDiff } from "../git/git.js";

type Range = { file?: string; side?: "new" | "old"; line?: number; startLine?: number; endLine?: number };

/** The `[first, last]` line spans of the hunks of a unified diff, per side. */
export function hunkSpans(diff: string): { old: [number, number][]; new: [number, number][] } {
  const spans = { old: [] as [number, number][], new: [] as [number, number][] };
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [os, oc, ns, nc] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    if (oc > 0) spans.old.push([os, os + oc - 1]);
    if (nc > 0) spans.new.push([ns, ns + nc - 1]);
  }
  return spans;
}

/**
 * Checks a comment's `file` and line range against the diff `from..to`: an error message, or undefined when it is fine
 * (or when the range cannot be resolved, as for a binary file).
 */
export async function checkAnchor(repo: string, from: string, to: string, input: Range): Promise<string | undefined> {
  if (input.file === undefined) return undefined;
  const files = await rangeChanges(repo, from, to);
  if (!files.some((f) => f.path === input.file)) return "file is not in this round's diff";
  const start = input.startLine ?? input.line;
  if (start === undefined) return undefined;
  const end = input.endLine ?? start;
  const spans = hunkSpans(await rangeFileDiff(repo, from, to, input.file));
  const list = (input.side ?? "new") === "old" ? spans.old : spans.new;
  if (list.length === 0) return undefined;
  return list.some(([a, b]) => start >= a && end <= b) ? undefined : "lines are not in this file's diff";
}
