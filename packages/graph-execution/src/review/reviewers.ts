import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ENGINE_PROVIDER_IDS } from "../providers/catalog.js";

/** The env var naming the reviewers file when `--reviewers` is not given; an empty value counts as unset. */
export const REVIEWERS_ENV = "GRAPH_EXECUTION_REVIEWERS";
/** The copy of the reviewers file in the run dir. */
export const RUN_REVIEWERS_FILE = "reviewers.json";
/** Providers a reviewer may name (the run providers plus the hidden test provider `fake`). */
export const REVIEWER_PROVIDERS = [...ENGINE_PROVIDER_IDS, "fake"] as unknown as readonly [string, ...string[]];
/** Ids that would collide with a pipeline node (`@reviewer`, `@fixer`, `@gate`, `@gate-fixer`, `@merge`, the web page's `@human`). */
export const RESERVED_REVIEWER_IDS = ["reviewer", "fixer", "gate", "gate-fixer", "merge", "human", "validate"] as const;
export const blockAtSchema = z.enum(["major", "blocker", "never"]);

/** Why `glob` is not a valid reviewer glob, or undefined when it is. Only `*`, `**` and `?` are special. */
export function checkGlob(glob: string): string | undefined {
  const why = ((): string | undefined => {
    const body = glob.startsWith("!") ? glob.slice(1) : glob;
    if (body === "") return "it is empty";
    if (body.includes("\0")) return "it contains a NUL character";
    if (body.startsWith("/")) return "it must be relative to the repo root";
    if (body.split("/").includes("..")) return "it must not contain a `..` segment";
    const bad = /[[\]{}\\]/.exec(body);
    if (bad) return `the character "${bad[0]}" is not supported (only *, ** and ? are)`;
    return undefined;
  })();
  return why === undefined ? undefined : `invalid glob "${glob}": ${why}`;
}

export const globSchema = z.string().superRefine((g, ctx) => {
  const message = checkGlob(g);
  if (message) ctx.addIssue({ code: "custom", message });
});

/** A regexp matching the repo-relative paths `glob` matches: `**` across directories, `*` and `?` within one. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else if (glob[i] === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += glob[i]!.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * The files matched by `globs`, in input order: all of them without globs; otherwise those matching at least one
 * positive glob (or any file when there is none) and no `!` glob.
 */
export function matchFiles(files: readonly string[], globs: readonly string[] | undefined): string[] {
  if (!globs || globs.length === 0) return [...files];
  const positive = globs.filter((g) => !g.startsWith("!")).map(globToRegExp);
  const negative = globs.filter((g) => g.startsWith("!")).map((g) => globToRegExp(g.slice(1)));
  return files.filter((f) => (positive.length === 0 || positive.some((r) => r.test(f))) && !negative.some((r) => r.test(f)));
}

const REPO_FILE_MESSAGE = "repoFile: must be a .md file name at the repo root";
export const repoFileSchema = z
  .string()
  .refine(
    (f) =>
      f.length >= 1 &&
      f.length <= 100 &&
      !/[/\\\0]/.test(f) &&
      f !== "." &&
      f !== ".." &&
      !f.includes("..") &&
      f.toLowerCase().endsWith(".md"),
    REPO_FILE_MESSAGE,
  );

export const reviewerSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "id: use lowercase letters, digits and single hyphens")
    .max(32)
    .refine((id) => !(RESERVED_REVIEWER_IDS as readonly string[]).includes(id), "id: this id is reserved"),
  type: z.enum(["diff", "tester"]),
  name: z.string().trim().min(1).max(60),
  enabled: z.boolean().default(true),
  instructions: z.string().max(20_000).default(""),
  repoFile: repoFileSchema,
  provider: z.enum(REVIEWER_PROVIDERS).optional(),
  model: z.string().trim().min(1).optional(),
  files: z.array(globSchema).optional(),
  blockAt: blockAtSchema.default("major"),
});
export type Reviewer = z.infer<typeof reviewerSchema>;
export type ReviewerInput = z.input<typeof reviewerSchema>;

export const reviewersFileSchema = z.strictObject({ reviewers: z.array(reviewerSchema) }).superRefine((v, ctx) => {
  const ids = new Set<string>();
  const repoFiles = new Map<string, string>();
  v.reviewers.forEach((r, i) => {
    if (ids.has(r.id)) ctx.addIssue({ code: "custom", path: ["reviewers", i, "id"], message: `id: duplicate reviewer id "${r.id}"` });
    ids.add(r.id);
    const key = r.repoFile.toLowerCase();
    const other = repoFiles.get(key);
    if (other !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["reviewers", i, "repoFile"],
        message: `repoFile: "${r.repoFile}" is already used by reviewer "${other}"`,
      });
    } else repoFiles.set(key, r.id);
    if (r.type === "tester" && r.id !== "tester") {
      ctx.addIssue({ code: "custom", path: ["reviewers", i, "type"], message: 'type: only the reviewer with id "tester" can have type "tester"' });
    }
    if (r.id === "tester" && r.type !== "tester") {
      ctx.addIssue({ code: "custom", path: ["reviewers", i, "type"], message: 'type: the reviewer "tester" must have type "tester"' });
    }
  });
});

/** Today's role text of the two built-in reviewers: exactly the first two lines of their prompts. */
export const BUILTIN_INSTRUCTIONS = {
  code: "You are the code reviewer of a change set built by AI coding agents from the specification below.\nJudge the result against what the specification asks for.",
  tester:
    "You are the live tester of a change set built by AI coding agents from the specification below.\nRun the result and check that it behaves as the specification asks.",
} as const;

/** The reviewers of a run without a reviewers file: today's code reviewer and live tester. */
export const BUILTIN_REVIEWERS: readonly Reviewer[] = [
  { id: "code", type: "diff", name: "Code review", enabled: true, instructions: BUILTIN_INSTRUCTIONS.code, repoFile: "REVIEW.md", blockAt: "major" },
  { id: "tester", type: "tester", name: "Live test", enabled: true, instructions: BUILTIN_INSTRUCTIONS.tester, repoFile: "TESTING.md", blockAt: "major" },
];

export class ReviewersError extends Error {}

/** Validates a parsed reviewers file; `where` names it in the error. Returns every reviewer, disabled included. */
export function parseReviewers(raw: unknown, where: string): Reviewer[] {
  const result = reviewersFileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.length > 0 ? `${i.path.join(".")}: ` : ""}${i.message}`);
    throw new ReviewersError(`invalid reviewers file ${where}:\n${issues.join("\n")}`);
  }
  return result.data.reviewers;
}

/** Reads and validates a reviewers file. Returns every reviewer, disabled included. */
export async function loadReviewersFile(file: string): Promise<Reviewer[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new ReviewersError(`reviewers file not found: ${file}`);
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ReviewersError(`invalid JSON in reviewers file ${file}: ${(err as Error).message}`);
  }
  return parseReviewers(raw, file);
}

export const enabledReviewers = (list: readonly Reviewer[]): Reviewer[] => list.filter((r) => r.enabled);

/** The reviewers file of a new run: `--reviewers`, else a non-empty `GRAPH_EXECUTION_REVIEWERS`. */
export function reviewersFileOf(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return flag ?? (env[REVIEWERS_ENV] ? env[REVIEWERS_ENV] : undefined);
}

/** The run's `--review-provider` / `--review-model` (else `reviewProvider` / `reviewModel` in the config). */
export interface ReviewDefaults {
  reviewProvider?: string | undefined;
  reviewModel?: string | undefined;
}

/**
 * Gives every reviewer without its own `provider` the review provider and, when it has no `model`, the review model.
 * A reviewer with its own provider keeps it and its own model (else the run's `--model`).
 */
export function applyReviewDefaults(list: readonly Reviewer[], d: ReviewDefaults): Reviewer[] {
  return list.map((r) => {
    if (r.provider || (!d.reviewProvider && !d.reviewModel)) return r;
    return {
      ...r,
      ...(d.reviewProvider ? { provider: d.reviewProvider as Reviewer["provider"] } : {}),
      ...(r.model === undefined && d.reviewModel ? { model: d.reviewModel } : {}),
    };
  });
}

/** The enabled reviewers of a run: from its copy of the reviewers file, else the built-ins; with the review defaults applied. */
export async function readRunReviewers(runDir: string, d: ReviewDefaults = {}): Promise<Reviewer[]> {
  const file = path.join(runDir, RUN_REVIEWERS_FILE);
  let list: Reviewer[];
  try {
    list = enabledReviewers(await loadReviewersFile(file));
  } catch (err) {
    if (err instanceof ReviewersError && err.message.startsWith("reviewers file not found")) list = BUILTIN_REVIEWERS.map((r) => ({ ...r }));
    else throw err;
  }
  return applyReviewDefaults(list, d);
}

/** Lower-case name in log lines and steps: `code review`, `live test`, else the reviewer's name. */
export const stepName = (r: Pick<Reviewer, "id" | "name">): string => (r.id === "code" ? "code review" : r.id === "tester" ? "live test" : r.name);
/** `code review not performed`, `live test not performed`, `<name> not performed`. */
export const notPerformed = (r: Pick<Reviewer, "id" | "name">): string => `${stepName(r)} not performed`;
/** The agent key of a reviewer in run events: `reviewer` for `code`, `tester` for `tester`, else its id. */
export const reviewerAgent = (id: string): string => (id === "code" ? "reviewer" : id);
/** Its node id: `@reviewer` for `code`, else `@<id>` (`@tester`, `@security`). */
export const reviewerNode = (id: string): string => (id === "code" ? "@reviewer" : `@${id}`);
