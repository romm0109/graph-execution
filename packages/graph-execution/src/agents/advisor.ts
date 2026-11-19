// The escalation advisor (docs/prd/escalation.md, "Advisor"): the run provider's interactive CLI in a PTY, in its own
// detached worktree at the integration head, told to read `<runDir>/escalations/<id>/advisor.md`. The user talks the
// decision through with it on the run page's escalation screen; it writes the agreed resolution to the draft file and,
// when asked, applies it with `graph-execution resolve`.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { draftPath } from "../escalation/draft.js";
import type { EscalationRecord } from "../escalation/schema.js";
import { escalationsDir, loadEscalations } from "../escalation/store.js";
import { addDetachedWorktree, removeWorktreeIfPresent } from "../git/git.js";
import type { Task } from "../graph/task.js";
import type { Provider } from "../providers/types.js";
import type { RunEmitter } from "../runner/events.js";
import { RUN_ENV_UNSET, RUNS_ROOT_ENV, WEB_TOKEN_ENV } from "../state/paths.js";
import type { TaskState } from "../state/state.js";
import { createPtySessionSync, type PtyModule, type PtySession } from "../terminal/pty.js";
import { fixSpawnHelper } from "../terminal/pty-helper.js";

/** `<runDir>/escalations/<id>/advisor.md` */
export const advisorContextPath = (runDir: string, id: string): string => path.join(escalationsDir(runDir), id, "advisor.md");

/** `<runDir>/worktrees/advisor-<id>` */
export const advisorWorktree = (runDir: string, id: string): string => path.join(runDir, "worktrees", `advisor-${id}`);

export const advisorFirstMessage = (contextFile: string): string => `Read ${contextFile} and follow it.`;

/** Shown on the escalation screen when node-pty cannot be loaded (a sandboxed run). */
export const ADVISOR_UNAVAILABLE =
  "The advisor terminal isn't available here (node-pty is missing). Write the draft by hand or use graph-execution resolve.";

/**
 * The built CLI. From `src` under vitest there is no `cli.js` next to `src/agents`, so the build's copy is used
 * (vitest's global setup builds `dist/` first).
 */
export function defaultCliPath(): string {
  const here = fileURLToPath(new URL("../cli.js", import.meta.url));
  return existsSync(here) ? here : fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
}

export interface AdvisorContextInput {
  runDir: string;
  runId: string;
  /** The escalation the advisor is for. */
  record: EscalationRecord;
  /** Every other open escalation. */
  others: EscalationRecord[];
  /** The run's copy of the spec, when there is one. */
  specPath?: string;
  /** The folder holding the full task files. */
  tasksPath?: string;
  tasks: Task[];
  states: Record<string, TaskState>;
  /** The integration branch, `graph/<run-id>`, and the commit the run started from (for the fixer's diff). */
  integrationBranch: string;
  startingCommit?: string;
  nodePath: string;
  cliPath: string;
}

export interface AdvisorContext {
  file: string;
  draft: string;
  /** `<node> <cli> resolve --run <run-id> --file <draft>` */
  apply: string[];
}

/** One argument as a shell user would type it: quoted when it has spaces or quotes. */
const shellArg = (a: string): string => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`);

const RESOLUTION_FORMAT = [
  "```",
  "{",
  '  "escalationIds": string[],          // at least one open escalation id, e.g. ["E1"]',
  '  "action": "continue" | "change" | "abort",',
  '  "guidance"?: string,                // what the rerun agents are told',
  '  "answers"?: [{ "escalationId": string, "questionId": string, "answer": string }],',
  '  "editTasks"?: [{ "id": string, "content"?: string, "dependencies"?: string[], "validate"?: string[] | false | null }],',
  '  "addTasks"?: [{ "id": string, "content": string, "dependencies"?: string[], "validate"?: string[] | false | null }],',
  '  "removeTasks"?: string[],',
  '  "reopen"?: string[]                 // merged tasks to run again on top of their work',
  "}",
  "```",
  "",
  "- `continue`: rerun the escalated task(s) with `guidance`; no task fields allowed.",
  "- `change`: apply the task fields, then rerun the escalated tasks that weren't removed, with `guidance`. Only `pending` or `escalated` tasks can be edited or removed; only `merged` tasks can be reopened; added ids must be new.",
  "- `abort`: end the run.",
];

/** Writes `advisor.md` for `input.record` and returns its path, the draft path and the apply command. */
export async function advisorContext(input: AdvisorContextInput): Promise<AdvisorContext> {
  const { record, runDir } = input;
  const file = advisorContextPath(runDir, record.id);
  const draft = draftPath(runDir, record.id);
  const apply = [input.nodePath, input.cliPath, "resolve", "--run", input.runId, "--file", draft];
  const who = record.node === "fixer" ? "the review-phase fixer" : `task ${record.node}`;
  const out: string[] = [
    `# Escalation ${record.id}`,
    "",
    `An agent working on ${who} stopped and asked for a decision (source: ${record.source}). You help the user decide how the run goes on.`,
    "",
    `Reason: ${record.reason}`,
    "",
    "Evidence:",
    "",
    record.evidence,
    "",
    "Questions:",
    "",
  ];
  for (const q of record.questions) {
    out.push(`- ${q.id}: ${q.question}`);
    if (q.context) out.push(`  Context: ${q.context}`);
    if (q.suggestedOptions?.length) out.push(`  Suggested options: ${q.suggestedOptions.join(" | ")}`);
  }
  out.push("", "## Other open escalations", "");
  if (input.others.length === 0) out.push("None.");
  for (const o of input.others) {
    out.push(`- ${o.id} (${o.node === "fixer" ? "fixer" : `task ${o.node}`}, open): ${o.reason}. Record: ${path.join(escalationsDir(runDir), `${o.id}.json`)}`);
  }
  out.push("", "One resolution can close several escalations: list their ids in `escalationIds`.");
  out.push("", "## Spec", "", input.specPath ? input.specPath : "The run has no spec file.");
  out.push("", "## Tasks", "");
  if (input.tasksPath) out.push(`The full task files: ${input.tasksPath}`, "");
  for (const t of input.tasks) {
    const first = t.content.split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? "";
    const deps = t.dependencies.length > 0 ? `, after ${t.dependencies.join(", ")}` : "";
    out.push(`- ${t.id} (${input.states[t.id]?.status ?? "pending"}${deps}): ${first}`);
  }
  out.push("", "## The escalated work", "");
  const state = input.states[record.node];
  const branch = record.branch ?? state?.branch;
  const base = state?.baseSha;
  if (branch && base) {
    out.push(`The escalated attempt's commits are on \`${branch}\`, cut from \`${base}\`. Its partial work:`, "", "```", `git diff ${base}..${branch}`, "```");
  } else if (record.node === "fixer" && input.startingCommit) {
    out.push(`The fixer works on the integration branch \`${input.integrationBranch}\`. The run's changes so far:`, "", "```", `git diff ${input.startingCommit}..${input.integrationBranch}`, "```");
  } else {
    out.push("The escalated attempt left no commits.");
  }
  out.push("", `Your working directory is a detached checkout of \`${input.integrationBranch}\`, the merged work so far.`);
  out.push("", "## Resolution format", "", ...RESOLUTION_FORMAT, "");
  out.push(
    "Example (`continue`):",
    "",
    "```json",
    JSON.stringify({ escalationIds: [record.id], action: "continue", guidance: "Use option A: …" }, null, 2),
    "```",
    "",
    "Example (`change`):",
    "",
    "```json",
    JSON.stringify(
      {
        escalationIds: [record.id],
        action: "change",
        guidance: "Keep GraphQL only.",
        editTasks: [{ id: "5", content: "The new task text…", dependencies: ["2"] }],
        addTasks: [{ id: "7", content: "…", dependencies: ["2"] }],
        removeTasks: ["4"],
      },
      null,
      2,
    ),
    "```",
  );
  out.push(
    "",
    "## Rules",
    "",
    "- Talk the decision through with the user: explain the escalation, the options and their trade-offs, and ask what they want. Read the spec, the tasks and the escalated work as needed.",
    "- Don't change the repository: no edits, commits or branch changes. The run's agents do the work once the decision is made.",
    "- When the user agrees on a resolution, write it as JSON to the draft file below. The run page shows it as a summary, with an Apply button.",
    "- When the user asks you to apply it, run the apply command below and report what it printed. A refusal names what to fix: fix the draft and try again.",
    "",
    `Draft file: ${draft}`,
    `Apply command: ${JSON.stringify(apply)}`,
    "",
    "The apply command, to run in a shell:",
    "",
    "```",
    apply.map(shellArg).join(" "),
    "```",
    "",
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, out.join("\n"));
  return { file, draft, apply };
}

/** Why an advisor can't be started; `status` is the HTTP status of the route that asked. */
export class AdvisorError extends Error {
  constructor(
    readonly code: "unknown" | "not_open" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
  get status(): number {
    return this.code === "unknown" ? 404 : this.code === "not_open" ? 409 : 501;
  }
}

export type AdvisorStatus = "running" | "exited";

export interface AdvisorSessionsOptions {
  runDir: string;
  runId: string;
  repo: string;
  provider: Provider;
  model?: string;
  events?: RunEmitter;
  /** The integration branch: the worktree is cut (detached) from its head. */
  integrationBranch: string;
  startingCommit?: string;
  specPath?: string;
  tasksPath?: string;
  getTasks: () => Task[];
  getStates: () => Record<string, TaskState>;
  /** Default: the built `cli.js` (`defaultCliPath`). */
  cliPath?: string;
  /** Default: `process.execPath`. */
  nodePath?: string;
  /** Loads node-pty; a failure makes the advisor unavailable. */
  loadPty?: () => Promise<PtyModule>;
  /** The PTY's base environment; default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Serializes git operations on the worktree list with the run's own (its merge lock). */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

interface Entry {
  session: PtySession;
  status: AdvisorStatus;
  worktree: string;
}

const loadNodePty = async (): Promise<PtyModule> => {
  const mod = (await import("node-pty")) as unknown as PtyModule & { default?: PtyModule };
  fixSpawnHelper();
  return mod.default ?? mod;
};

/** Waits until `session` exits; SIGKILL after `ms`. */
function waitExit(session: PtySession, ms = 3000): Promise<void> {
  if (session.exited) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const done = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(last);
      att.detach();
      resolve();
    };
    let last: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      session.kill(process.platform === "win32" ? undefined : "SIGKILL");
      last = setTimeout(done, 1000);
    }, ms);
    const att = session.attach({ data: () => {}, exit: done });
  });
}

/** The advisor terminals of one run, one per escalation id. */
export class AdvisorSessions {
  private readonly sessions = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private closed = false;

  constructor(private readonly o: AdvisorSessionsOptions) {}

  /** Starts escalation `id`'s advisor unless it is running; an exited one starts again. */
  start(id: string): Promise<void> {
    return this.serial(id, async () => {
      const entry = this.sessions.get(id);
      if (entry?.status === "running") return;
      const record = await this.openRecord(id);
      if (entry) return this.respawn(id, entry, record);
      await this.spawn(id, record);
    });
  }

  /** Kills escalation `id`'s advisor (when it runs) and starts a new one in the same terminal. */
  restart(id: string): Promise<void> {
    return this.serial(id, async () => {
      const record = await this.openRecord(id);
      const entry = this.sessions.get(id);
      if (!entry) return this.spawn(id, record);
      entry.session.kill();
      await waitExit(entry.session);
      await this.respawn(id, entry, record);
    });
  }

  get(id: string): PtySession | undefined {
    return this.sessions.get(id)?.session;
  }

  statuses(): Record<string, AdvisorStatus> {
    return Object.fromEntries([...this.sessions].map(([id, e]) => [id, e.status]));
  }

  /** Calls `fn` whenever an advisor starts, exits or is stopped. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Kills escalation `id`'s advisor and removes its worktree. */
  stop(id: string): Promise<void> {
    return this.serial(id, async () => {
      const entry = this.sessions.get(id);
      if (!entry) return;
      this.sessions.delete(id);
      entry.session.kill();
      await waitExit(entry.session);
      entry.session.detachAll();
      await this.locked(() => removeWorktreeIfPresent(this.o.repo, entry.worktree)).catch(() => undefined);
      this.changed(id, "exited");
    });
  }

  /** Stops every advisor; no new one starts afterwards. */
  async stopAll(): Promise<void> {
    this.closed = true;
    await Promise.all([...new Set([...this.sessions.keys(), ...this.pending.keys()])].map((id) => this.stop(id)));
  }

  private async serial(id: string, fn: () => Promise<void>): Promise<void> {
    const before = this.pending.get(id) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(fn);
    // The caller gets `next`'s rejection; the queue only waits for it.
    const tracked = next.catch(() => undefined).finally(() => {
      if (this.pending.get(id) === tracked) this.pending.delete(id);
    });
    this.pending.set(id, tracked);
    return next;
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return this.o.withLock ? this.o.withLock(fn) : fn();
  }

  private changed(id: string, status: AdvisorStatus): void {
    this.o.events?.emit("escalation:advisor", { id, status });
    for (const fn of this.listeners) fn();
  }

  private async openRecord(id: string): Promise<{ record: EscalationRecord; all: EscalationRecord[] }> {
    if (this.closed) throw new AdvisorError("not_open", "the run has ended");
    const all = await loadEscalations(this.o.runDir);
    const record = all.find((r) => r.id === id);
    if (!record) throw new AdvisorError("unknown", `unknown escalation ${id}`);
    if (record.status !== "open") throw new AdvisorError("not_open", `escalation ${id} is already resolved`);
    if (!this.o.provider.interactive) throw new AdvisorError("unavailable", `the ${this.o.provider.name} provider has no interactive mode`);
    return { record, all };
  }

  private async writeContext({ record, all }: { record: EscalationRecord; all: EscalationRecord[] }): Promise<string> {
    const ctx = await advisorContext({
      runDir: this.o.runDir,
      runId: this.o.runId,
      record,
      others: all.filter((r) => r.status === "open" && r.id !== record.id),
      ...(this.o.specPath ? { specPath: this.o.specPath } : {}),
      ...(this.o.tasksPath ? { tasksPath: this.o.tasksPath } : {}),
      tasks: this.o.getTasks(),
      states: this.o.getStates(),
      integrationBranch: this.o.integrationBranch,
      ...(this.o.startingCommit ? { startingCommit: this.o.startingCommit } : {}),
      nodePath: this.o.nodePath ?? process.execPath,
      cliPath: this.o.cliPath ?? defaultCliPath(),
    });
    return ctx.file;
  }

  /** The PTY's environment: the run's own variables unset, except the runs root and the page token `resolve` needs. */
  private ptyEnv(extra: Record<string, string> | undefined): Record<string, string> {
    const env: Record<string, string | undefined> = { ...(this.o.env ?? process.env) };
    const token = env[WEB_TOKEN_ENV];
    for (const key of Object.keys(RUN_ENV_UNSET)) delete env[key];
    env[RUNS_ROOT_ENV] = path.dirname(this.o.runDir);
    if (token) env[WEB_TOKEN_ENV] = token;
    // As in graph-manager's terminals: the CLI never tries to open a browser.
    env.GRAPH_EXECUTION_HANDOFF = "detached";
    env.SSH_CONNECTION = "1";
    Object.assign(env, extra);
    return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string"));
  }

  private async spawn(id: string, opened: { record: EscalationRecord; all: EscalationRecord[] }): Promise<void> {
    let pty: PtyModule;
    try {
      pty = await (this.o.loadPty ?? loadNodePty)();
    } catch {
      throw new AdvisorError("unavailable", ADVISOR_UNAVAILABLE);
    }
    const worktree = advisorWorktree(this.o.runDir, id);
    await this.locked(async () => {
      await removeWorktreeIfPresent(this.o.repo, worktree);
      await addDetachedWorktree(this.o.repo, worktree, this.o.integrationBranch);
    });
    const contextFile = await this.writeContext(opened);
    const firstMessage = advisorFirstMessage(contextFile);
    const cmd = this.o.provider.interactive!({ cwd: worktree, firstMessage, ...(this.o.model ? { model: this.o.model } : {}) });
    let session: PtySession;
    try {
      session = createPtySessionSync(pty, {
        file: cmd.file,
        args: cmd.args,
        cwd: worktree,
        env: this.ptyEnv(cmd.env),
        cols: 100,
        rows: 30,
        ...(cmd.typeFirstMessage ? { input: `${firstMessage}\r` } : {}),
      });
    } catch (err) {
      await this.locked(() => removeWorktreeIfPresent(this.o.repo, worktree)).catch(() => undefined);
      throw new AdvisorError("unavailable", `the advisor could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
    const entry: Entry = { session, status: "running", worktree };
    this.sessions.set(id, entry);
    session.attach({
      data: () => {},
      exit: () => {
        if (this.sessions.get(id) !== entry || entry.status === "exited") return;
        entry.status = "exited";
        this.changed(id, "exited");
      },
      restart: () => {
        entry.status = "running";
      },
    });
    this.changed(id, "running");
  }

  private async respawn(id: string, entry: Entry, opened: { record: EscalationRecord; all: EscalationRecord[] }): Promise<void> {
    await this.writeContext(opened);
    entry.session.restart();
    entry.status = "running";
    this.changed(id, "running");
  }
}
