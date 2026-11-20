/**
 * Fits a change set's diff into a reviewer prompt. A large run's diff (hundreds of files, lockfiles, generated
 * snapshots) can be larger than the model's context window, and the provider then rejects the first request.
 * Generated files are never inlined, only listed. When the rest fits `budget` characters it is inlined whole;
 * otherwise no diff is inlined and the reviewer gets the changed files grouped by area, to review group by group.
 */

/** About 100k tokens of diff; the spec, the instructions and the reviewer's own work need the rest of the window. */
export const PROMPT_DIFF_BUDGET = 400_000;

export interface FileDiffPart {
  path: string;
  text: string;
  added: number;
  removed: number;
}

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
}

export interface FileGroup {
  /** The folder the group's files are in, e.g. `apps/server`; `.` for files at the repo root. */
  name: string;
  files: ChangedFile[];
}

/** One subagent's share of a large review: neighbouring folder groups, together at most `MAX_GROUP_FILES` files. */
export interface ReviewPart {
  folders: string[];
  files: ChangedFile[];
}

export type PromptDiff =
  /** The diff is inlined: every file but the generated ones. */
  | { mode: "inline"; text: string; generated: ChangedFile[] }
  /** The diff is too large: no diff is inlined, the changed files come grouped by area. */
  | { mode: "files"; parts: ReviewPart[]; generated: ChangedFile[]; chars: number };

const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
]);

/** Lockfiles, minified bundles, source maps and migration snapshots: machine-written, not worth a reviewer's context. */
export function isGeneratedFile(file: string): boolean {
  const base = file.slice(file.lastIndexOf("/") + 1);
  if (LOCKFILES.has(base)) return true;
  if (/\.min\.(js|mjs|css)$/.test(base) || /\.map$/.test(base)) return true;
  return /(^|\/)migrations\/meta\/[^/]*snapshot\.json$/.test(file);
}

/** Splits `git diff` output into one part per file. Text before the first `diff --git` line is dropped. */
export function splitDiff(diff: string): FileDiffPart[] {
  const parts: FileDiffPart[] = [];
  const starts = [...diff.matchAll(/^diff --git /gm)].map((m) => m.index);
  starts.forEach((start, i) => {
    const text = diff.slice(start, starts[i + 1] ?? diff.length);
    const header = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
    const m = / b\/(.+)$/.exec(header);
    let added = 0;
    let removed = 0;
    let inHunk = false;
    for (const line of text.split("\n")) {
      if (line.startsWith("@@")) inHunk = true;
      else if (!inHunk) continue;
      else if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
    parts.push({ path: m?.[1] ?? header.slice("diff --git ".length), text, added, removed });
  });
  return parts;
}

/** A group with more files than this is split by the next folder level, so one subagent's share stays readable. */
export const MAX_GROUP_FILES = 50;

/** A file's folder `depth` levels deep (`apps/server` at 2); shallower files get their own folder, `.` at the root. */
export function groupOf(file: string, depth = 2): string {
  const dirs = file.split("/").slice(0, -1);
  return dirs.length === 0 ? "." : dirs.slice(0, depth).join("/");
}

/** Groups files by their first two folders, splitting a group of more than `max` files one folder level deeper. */
export function groupFiles(files: readonly ChangedFile[], max = MAX_GROUP_FILES, depth = 2): FileGroup[] {
  const byName = new Map<string, ChangedFile[]>();
  for (const f of files) {
    const name = groupOf(f.path, depth);
    byName.set(name, [...(byName.get(name) ?? []), f]);
  }
  return [...byName].flatMap(([name, group]) => {
    // Deeper only while it splits the group: files directly in the folder cannot go deeper.
    const deeper = group.length > max && new Set(group.map((f) => groupOf(f.path, depth + 1))).size > 1;
    return deeper ? groupFiles(group, max, depth + 1) : [{ name, files: group }];
  });
}

/** Packs neighbouring groups (in path order, so related folders stay together) into parts of at most `max` files. */
export function packGroups(groups: readonly FileGroup[], max = MAX_GROUP_FILES): ReviewPart[] {
  const parts: ReviewPart[] = [];
  for (const g of groups) {
    const last = parts.at(-1);
    if (last && last.files.length + g.files.length <= max) {
      last.folders.push(g.name);
      last.files.push(...g.files);
    } else parts.push({ folders: [g.name], files: [...g.files] });
  }
  return parts;
}

/** The part of `diff` that goes into a reviewer prompt; see the module comment. */
export function promptDiff(diff: string, budget = PROMPT_DIFF_BUDGET): PromptDiff {
  const parts = splitDiff(diff);
  if (parts.length === 0) return { mode: "inline", text: diff, generated: [] };
  const counts = (p: FileDiffPart): ChangedFile => ({ path: p.path, added: p.added, removed: p.removed });
  const generated = parts.filter((p) => isGeneratedFile(p.path)).map(counts);
  const source = parts.filter((p) => !isGeneratedFile(p.path));
  const chars = source.reduce((n, p) => n + p.text.length, 0);
  if (chars <= budget) return { mode: "inline", text: source.map((p) => p.text).join(""), generated };
  return { mode: "files", parts: packGroups(groupFiles(source.map(counts))), generated, chars };
}
