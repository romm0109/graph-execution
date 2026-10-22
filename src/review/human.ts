import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type TestCase, type TestPlan } from "../graph/testPlan.js";
import { type Finding, type Report, readReport } from "./report.js";

export const HUMAN_DIR = "human";

const commentBase = z.object({
  id: z.string().regex(/^H\d+-\d+$/),
  round: z.number().int().min(1),
  file: z.string().min(1).optional(),
  side: z.enum(["new", "old"]).optional(),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  line: z.number().int().min(1).optional(), // legacy: one new-side line
  snippet: z.string().max(2000).optional(),
  body: z.string().trim().min(1).max(10_000),
  liveCheck: z.boolean().default(false),
  status: z.enum(["open", "resolved", "reopened"]).default("open"),
  followUps: z.array(z.string().min(1)).default([]),
});

/** A comment anchors to a range on one side of the diff; the legacy `line` becomes a one-line new-side range. */
export const commentSchema = commentBase
  .transform(({ line, ...c }) =>
    line !== undefined && c.startLine === undefined
      ? { ...c, side: "new" as const, startLine: line, endLine: line }
      : c.startLine !== undefined
        ? { ...c, side: c.side ?? ("new" as const), endLine: c.endLine ?? c.startLine }
        : c,
  )
  .superRefine((c, ctx) => {
    if (c.startLine === undefined) return;
    if (c.file === undefined) ctx.addIssue({ code: "custom", message: "line needs a file" });
    else if (c.endLine !== undefined && c.endLine < c.startLine) ctx.addIssue({ code: "custom", message: "endLine before startLine" });
    else if (c.endLine !== undefined && c.endLine - c.startLine > 500) ctx.addIssue({ code: "custom", message: "range too long" });
  });
export type Comment = z.output<typeof commentSchema>;
export type CommentInput = z.input<typeof commentSchema>;

/** The replacement text of the first ```suggestion block, or undefined. An empty block means "delete these lines" (""). */
export function parseSuggestion(body: string): string | undefined {
  const m = /^```suggestion[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m.exec(body);
  if (!m) return undefined;
  return m[1]!.replace(/\r?\n$/, "");
}

const checkSuggestion = (c: Pick<Comment, "body" | "side" | "startLine">): void => {
  if (parseSuggestion(c.body) !== undefined && (c.side !== "new" || c.startLine === undefined)) throw new HumanReviewError("suggestion needs side new");
};

/** "new L12–L18", "old L40", or "" when the comment has no lines. */
export const rangeLabel = (c: Pick<Comment, "side" | "startLine" | "endLine">): string =>
  c.startLine === undefined ? "" : `${c.side ?? "new"} L${c.startLine}${c.endLine && c.endLine !== c.startLine ? `–L${c.endLine}` : ""}`;

/** The location text of a comment in the agent prompts: " `a.ts` new lines 12–18", or "" for a general comment. */
export const commentWhere = (c: Pick<Comment, "file" | "side" | "startLine" | "endLine">): string =>
  c.file
    ? ` \`${c.file}\`${c.startLine ? ` ${c.side === "old" ? "old" : "new"} lines ${c.startLine}${c.endLine && c.endLine !== c.startLine ? `–${c.endLine}` : ""}` : ""}`
    : "";

export const REMOVED_NOTE = "(These lines were removed by the change; the reviewer is commenting on the removal.)";

export const humanRoundSchema = z.object({
  round: z.number().int().min(1),
  diffBase: z.string().min(1),
  diffHead: z.string().min(1),
  comments: z.array(commentSchema),
});
export type HumanRound = z.infer<typeof humanRoundSchema>;

/** A comment edit that cannot be done: unknown id or a comment of an earlier round. */
export class HumanReviewError extends Error {
  constructor(
    message: string,
    readonly kind: "unknown" | "invalid" = "invalid",
  ) {
    super(message);
    this.name = "HumanReviewError";
  }
}

export const humanRoundPath = (runDir: string, round: number): string => path.join(runDir, HUMAN_DIR, `round${round}.json`);

export async function loadHumanRound(runDir: string, round: number): Promise<HumanRound | undefined> {
  let text: string;
  try {
    text = await readFile(humanRoundPath(runDir, round), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return humanRoundSchema.parse(JSON.parse(text));
}

/** Writes a tmp file then renames it over the round file, so readers never see a partial file. */
export async function saveHumanRound(runDir: string, data: HumanRound): Promise<void> {
  const file = humanRoundPath(runDir, data.round);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(humanRoundSchema.parse(data), null, 2)}\n`);
  await rename(tmp, file);
}

/** Creates the round's file; an existing one (a resume) is kept. */
export async function startHumanRound(runDir: string, round: number, diffBase: string, diffHead: string): Promise<HumanRound> {
  const existing = await loadHumanRound(runDir, round);
  if (existing) return existing;
  const created: HumanRound = { round, diffBase, diffHead, comments: [] };
  await saveHumanRound(runDir, created);
  return created;
}

/** The comments of rounds 1..upToRound, in order. */
export async function allComments(runDir: string, upToRound: number): Promise<Comment[]> {
  const out: Comment[] = [];
  for (let round = 1; round <= upToRound; round++) out.push(...((await loadHumanRound(runDir, round))?.comments ?? []));
  return out;
}

export const openComments = (comments: readonly Comment[]): Comment[] => comments.filter((c) => c.status !== "resolved");

export const commentFindingId = (id: string): string => `human-${id}`;

/** A blocker per open comment; failureScenario is never empty, so normalizeReport never downgrades it. */
export function commentFindings(comments: readonly Comment[]): Finding[] {
  return openComments(comments).map((c) => ({
    id: commentFindingId(c.id),
    severity: "blocker",
    ...(c.file ? { file: c.file } : {}),
    ...(c.startLine ? { line: c.startLine } : {}),
    ...(c.startLine && c.endLine ? { endLine: c.endLine } : {}),
    ...(c.startLine && c.side ? { side: c.side } : {}),
    description: [c.body, ...c.followUps].join("\n\nFollow-up: "),
    failureScenario: c.file ? (`${c.file} ${rangeLabel(c)}`.trim() + "\n" + (c.snippet ?? "")).trim() : "general comment on the whole change",
    status: "open",
  }));
}

/** Adds or updates human-<id> findings in the code report from its verdicts; missing verdicts count as not_addressed. */
export function applyCommentVerdicts(report: Report, comments: readonly Comment[]): Report {
  const verdicts = new Map((report.comments ?? []).map((v) => [v.id, v]));
  const own = report.findings.filter((f) => !f.id.startsWith("human-"));
  const added = openComments(comments).map((c): Finding => {
    const base = commentFindings([c])[0]!;
    const v = verdicts.get(c.id);
    if (v?.verdict === "addressed") return { ...base, status: "fixed" };
    const evidence = v?.evidence?.trim() ? v.evidence : "no verdict from the code reviewer";
    return { ...base, status: "not_fixed", failureScenario: `${base.failureScenario}\nCode reviewer: ${evidence}` };
  });
  return { ...report, findings: [...own, ...added] };
}

export const fixerCommentsPath = (runDir: string, round: number): string =>
  path.join(runDir, "reports", `round${round}`, "fixer-comments.json");

export const fixerNoteSchema = z.array(z.object({ id: z.string().min(1), note: z.string() }));

/** The fixer's note per comment id; empty when the file is missing or invalid. */
export async function readFixerNotes(runDir: string, round: number): Promise<Record<string, string>> {
  try {
    const parsed = fixerNoteSchema.parse(JSON.parse(await readFile(fixerCommentsPath(runDir, round), "utf8")));
    return Object.fromEntries(parsed.map((n) => [n.id, n.note]));
  } catch {
    return {};
  }
}

export interface CommentOutcome {
  fixerNote?: string;
  verdict?: "addressed" | "not_addressed";
  evidence?: string;
  liveCheck?: { verdict: "pass" | "fail" | "blocked"; evidence?: string };
}

/** Outcome of each comment in the last review round (`reports/round<round>/`); {} for comments not sent there. */
export async function commentOutcomes(runDir: string, round: number, comments: readonly Comment[]): Promise<Record<string, CommentOutcome>> {
  const dir = path.join(runDir, "reports", `round${round}`);
  const [code, tester, notes] = await Promise.all([
    readReport(path.join(dir, "code.json"), round, "code"),
    readReport(path.join(dir, "tester.json"), round, "tester"),
    readFixerNotes(runDir, round),
  ]);
  const verdicts = new Map((code?.comments ?? []).map((v) => [v.id, v]));
  const cases = new Map((tester?.cases ?? []).map((c) => [c.id, c]));
  const out: Record<string, CommentOutcome> = {};
  for (const c of comments) {
    const v = verdicts.get(c.id);
    const t = c.liveCheck ? cases.get(c.id) : undefined;
    const outcome: CommentOutcome = {
      ...(notes[c.id] !== undefined ? { fixerNote: notes[c.id]! } : {}),
      ...(v ? { verdict: v.verdict, ...(v.evidence ? { evidence: v.evidence } : {}) } : {}),
      ...(t ? { liveCheck: { verdict: t.verdict, ...(t.evidence ? { evidence: t.evidence } : {}) } } : {}),
    };
    if (Object.keys(outcome).length > 0) out[c.id] = outcome;
  }
  return out;
}

/** Serializes edits per run dir; every method saves before resolving. */
export class HumanReviewStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly runDir: string) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async latest(): Promise<HumanRound> {
    let names: string[] = [];
    try {
      names = await readdir(path.join(this.runDir, HUMAN_DIR));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const rounds = names.map((n) => /^round(\d+)\.json$/.exec(n)).filter((m) => m !== null).map((m) => Number(m[1]));
    if (rounds.length === 0) throw new HumanReviewError("no human review round has started");
    const data = await loadHumanRound(this.runDir, Math.max(...rounds));
    if (!data) throw new HumanReviewError("no human review round has started");
    return data;
  }

  current(): Promise<HumanRound> {
    return this.serial(() => this.latest());
  }

  add(input: { file?: string; side?: "new" | "old"; startLine?: number; endLine?: number; line?: number; snippet?: string; body: string; liveCheck?: boolean }): Promise<Comment> {
    return this.serial(async () => {
      const data = await this.latest();
      const prefix = `H${data.round}-`;
      const max = data.comments.reduce((m, c) => (c.id.startsWith(prefix) ? Math.max(m, Number(c.id.slice(prefix.length))) : m), 0);
      if ((input.line !== undefined || input.startLine !== undefined) && input.file === undefined) throw new HumanReviewError("line needs a file");
      const parsed = commentSchema.safeParse({ ...input, id: `${prefix}${max + 1}`, round: data.round });
      if (!parsed.success) throw new HumanReviewError(parsed.error.issues[0]?.message ?? "invalid comment");
      checkSuggestion(parsed.data);
      await saveHumanRound(this.runDir, { ...data, comments: [...data.comments, parsed.data] });
      return parsed.data;
    });
  }

  edit(id: string, patch: { body?: string; liveCheck?: boolean }): Promise<Comment> {
    return this.serial(async () => {
      const data = await this.latest();
      const old = this.find(data, id);
      const parsed = commentSchema.safeParse({
        ...old,
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.liveCheck !== undefined ? { liveCheck: patch.liveCheck } : {}),
      });
      if (!parsed.success) throw new HumanReviewError(parsed.error.issues[0]?.message ?? "invalid comment");
      checkSuggestion(parsed.data);
      await saveHumanRound(this.runDir, { ...data, comments: data.comments.map((c) => (c.id === id ? parsed.data : c)) });
      return parsed.data;
    });
  }

  resolve(id: string): Promise<Comment> {
    return this.setStatus(id, "resolved");
  }

  reopen(id: string, followUp?: string): Promise<Comment> {
    return this.setStatus(id, "reopened", followUp?.trim() || undefined);
  }

  /** Changes the status of a comment of an earlier round, in that round's own file. */
  private setStatus(id: string, status: "resolved" | "reopened", followUp?: string): Promise<Comment> {
    return this.serial(async () => {
      const current = await this.latest();
      const match = /^H(\d+)-\d+$/.exec(id);
      const round = match ? Number(match[1]) : 0;
      if (round === current.round && current.comments.some((c) => c.id === id)) {
        throw new HumanReviewError(`${id} belongs to the current round: edit or delete it instead`);
      }
      const data = round >= 1 && round < current.round ? await loadHumanRound(this.runDir, round) : undefined;
      const old = data?.comments.find((c) => c.id === id);
      if (!data || !old) throw new HumanReviewError(`unknown comment ${id}`, "unknown");
      const updated: Comment = { ...old, status, followUps: followUp ? [...old.followUps, followUp] : old.followUps };
      await saveHumanRound(this.runDir, { ...data, comments: data.comments.map((c) => (c.id === id ? updated : c)) });
      return updated;
    });
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const data = await this.latest();
      this.find(data, id);
      await saveHumanRound(this.runDir, { ...data, comments: data.comments.filter((c) => c.id !== id) });
    });
  }

  private find(data: HumanRound, id: string): Comment {
    const found = data.comments.find((c) => c.id === id);
    if (found) return found;
    const earlier = /^H(\d+)-\d+$/.exec(id);
    if (earlier && Number(earlier[1]) < data.round) throw new HumanReviewError(`${id} belongs to an earlier round`);
    throw new HumanReviewError(`unknown comment ${id}`, "unknown");
  }
}

const firstLine = (text: string, max: number): string => {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Open comments marked "needs live check", as must cases for the live tester (id = comment id). */
export function liveCheckCases(comments: readonly Comment[]): TestCase[] {
  return openComments(comments)
    .filter((c) => c.liveCheck)
    .map((c) => {
      const asked = [c.body, ...c.followUps].join(" / ");
      return {
        id: c.id,
        title: firstLine(c.body, 80),
        steps: [
          "Start the app as TESTING.md describes",
          c.file ? `Exercise the behavior of ${c.file}${c.startLine ? ` around ${rangeLabel(c)}` : ""}` : "Exercise the changed behavior",
          `Check what the reviewer asked for: ${asked}`,
        ],
        expected: asked,
        priority: "must" as const,
      };
    });
}

/** The run's plan plus the live-check cases; undefined when both are empty. A plan case wins an id collision. */
export function withLiveChecks(plan: TestPlan | undefined, extra: TestCase[]): TestPlan | undefined {
  const taken = new Set((plan?.cases ?? []).map((c) => c.id));
  const cases = [...(plan?.cases ?? []), ...extra.filter((c) => !taken.has(c.id))];
  if (!plan && cases.length === 0) return undefined;
  return plan && cases.length === plan.cases.length ? plan : { ...plan, cases };
}
