// The run archive (docs/prd/hosted-sessions.md): a `runs` row per run of a user, and each ended run's folder as a
// .tar.gz blob (without git worktrees), so run history outlives the clone or container it ran in.
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { RunState } from "graph-execution/api";
import { checkKey, readAll, userKeySegment, type BlobStore } from "./blobs.js";

export { userKeySegment };
import type { Db } from "./db/db.js";
import { ADMIN_USER, type User } from "./identity.js";
import { attachPr, buildGraph, listHomeRuns, runDetail, runDirOf, type PrIndex, type RunDetail, type RunSummary } from "./runs.js";
import { projectHome, workspaceHome, type RunHome } from "./runhome.js";
import { projectsOf, type Store } from "./store.js";
import { gzipTar, readTarGz, tarArchive, type TarEntry } from "./tar.js";
import { listWorkspaces } from "./workspaces.js";

export interface RunRow {
  status: string;
  startedAt?: string;
  endedAt?: string;
  prUrl?: string;
  state?: unknown;
  summary: RunSummary;
}

export interface ArchivedRun extends RunDetail {
  summary: RunSummary & { archived: true };
  archived: true;
  /** Paths inside the archived folder, sorted (files only). */
  files: string[];
  /** The last 200 lines of run.log, when archived. */
  logTail?: string;
}

export interface RunArchive {
  record(user: User, workspaceId: string, runId: string, row: RunRow): Promise<void>;
  saveFolder(user: User, workspaceId: string, runId: string, tarGz: Readable): Promise<void>;
  list(user: User, filter?: { workspaceId?: string }): Promise<RunSummary[]>;
  get(user: User, workspaceId: string, runId: string): Promise<ArchivedRun | undefined>;
  openFile(user: User, workspaceId: string, runId: string, rel: string): Promise<Readable | undefined>;
  /** Deletes every row and blob of the user (gateway account deletion). */
  deleteUser(userId: string): Promise<void>;
}

export const runBlobKey = (userId: string, workspaceId: string, runId: string): string =>
  checkKey(`runs/${userKeySegment(userId)}/${workspaceId}/${runId}.tar.gz`);

/** The synthetic entry of an archived folder with what graph-manager knew of the run. */
export const DETAIL_FILE = "gm-detail.json";
/** Files larger than this are left out of the archive (and listed in `skipped`). */
export const MAX_ARCHIVED_FILE = 64 * 1024 * 1024;
const LOG_TAIL_LINES = 200;

interface DetailFile {
  summary?: RunSummary;
  state?: RunState;
  graph?: RunDetail["graph"];
  tasks?: RunDetail["tasks"];
  view?: RunDetail["view"];
  skipped?: string[];
}

/** A path inside an archived folder that may be served: relative, no `..`, no NUL, nothing under `worktrees/`. */
export function archivePath(rel: string): string | undefined {
  if (rel === "" || rel.includes("\0") || rel.includes("\\") || path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) return undefined;
  if (rel.split("/").includes("..")) return undefined;
  const norm = path.posix.normalize(rel);
  if (norm === "." || norm.startsWith("../") || norm.split("/")[0] === "worktrees") return undefined;
  return norm;
}

function lastLinesOf(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

interface RunsRow {
  status: string;
  state: string | null;
  summary: string;
  blob_key: string | null;
}

export class SqlRunArchive implements RunArchive {
  constructor(
    private readonly db: Db,
    private readonly blobs: BlobStore,
  ) {}

  async record(user: User, workspaceId: string, runId: string, row: RunRow): Promise<void> {
    await this.db.exec(
      `INSERT INTO runs (user_id, workspace_id, run_id, status, started_at, ended_at, pr_url, state, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, workspace_id, run_id) DO UPDATE SET
         status = excluded.status, started_at = excluded.started_at, ended_at = excluded.ended_at,
         pr_url = excluded.pr_url, state = excluded.state, summary = excluded.summary`,
      [
        user.id,
        workspaceId,
        runId,
        row.status,
        row.startedAt ?? null,
        row.endedAt ?? null,
        row.prUrl ?? null,
        row.state === undefined ? null : JSON.stringify(row.state),
        JSON.stringify(row.summary),
      ],
    );
  }

  async saveFolder(user: User, workspaceId: string, runId: string, tarGz: Readable): Promise<void> {
    const key = runBlobKey(user.id, workspaceId, runId);
    await this.blobs.put(key, tarGz);
    const summary: RunSummary = { workspaceId, type: "run", id: runId, status: "unknown", kind: "archived", live: false };
    await this.db.exec(
      `INSERT INTO runs (user_id, workspace_id, run_id, status, summary, blob_key) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, workspace_id, run_id) DO UPDATE SET blob_key = excluded.blob_key`,
      [user.id, workspaceId, runId, "unknown", JSON.stringify(summary), key],
    );
  }

  async list(user: User, filter?: { workspaceId?: string }): Promise<RunSummary[]> {
    const params: string[] = [user.id];
    let where = "user_id = ?";
    if (filter?.workspaceId !== undefined) {
      where += " AND workspace_id = ?";
      params.push(filter.workspaceId);
    }
    const rows = await this.db.query<{ summary: string }>(
      `SELECT summary FROM runs WHERE ${where} ORDER BY COALESCE(started_at, '') DESC, run_id DESC`,
      params,
    );
    return rows.map((r) => archivedSummary(JSON.parse(r.summary) as RunSummary));
  }

  private async row(user: User, workspaceId: string, runId: string): Promise<RunsRow | undefined> {
    const rows = await this.db.query<RunsRow>(
      "SELECT status, state, summary, blob_key FROM runs WHERE user_id = ? AND workspace_id = ? AND run_id = ?",
      [user.id, workspaceId, runId],
    );
    return rows[0];
  }

  private async entries(key: string): Promise<TarEntry[] | undefined> {
    const stream = await this.blobs.get(key);
    return stream ? readTarGz(await readAll(stream)) : undefined;
  }

  async get(user: User, workspaceId: string, runId: string): Promise<ArchivedRun | undefined> {
    const row = await this.row(user, workspaceId, runId);
    if (!row) return undefined;
    const summary = archivedSummary(JSON.parse(row.summary) as RunSummary);
    const state = row.state ? (JSON.parse(row.state) as RunState) : undefined;
    const entries = row.blob_key ? await this.entries(row.blob_key) : undefined;
    const files: string[] = [];
    let saved: DetailFile = {};
    let logTail: string | undefined;
    for (const e of entries ?? []) {
      if (e.dir) continue;
      if (e.path === DETAIL_FILE) {
        try {
          saved = JSON.parse((e.content ?? Buffer.alloc(0)).toString("utf8")) as DetailFile;
        } catch {
          saved = {};
        }
        continue;
      }
      files.push(e.path);
      if (e.path === "run.log") logTail = lastLinesOf((e.content ?? Buffer.alloc(0)).toString("utf8"), LOG_TAIL_LINES);
    }
    files.sort();
    const detail: ArchivedRun = { summary, archived: true, files };
    const st = state ?? saved.state;
    if (st) detail.state = st;
    if (saved.graph) detail.graph = saved.graph;
    else if (st?.tasks) detail.graph = await buildGraph(st).catch(() => undefined);
    if (!detail.graph) delete detail.graph;
    if (saved.tasks) detail.tasks = saved.tasks;
    if (saved.view) detail.view = saved.view;
    if (logTail !== undefined) detail.logTail = logTail;
    return detail;
  }

  async openFile(user: User, workspaceId: string, runId: string, rel: string): Promise<Readable | undefined> {
    const want = archivePath(rel);
    if (want === undefined || want === DETAIL_FILE) return undefined;
    const row = await this.row(user, workspaceId, runId);
    if (!row?.blob_key) return undefined;
    const entry = (await this.entries(row.blob_key))?.find((e) => !e.dir && e.path === want);
    return entry ? Readable.from([entry.content ?? Buffer.alloc(0)]) : undefined;
  }

  async deleteUser(userId: string): Promise<void> {
    await this.db.exec("DELETE FROM runs WHERE user_id = ?", [userId]);
    await this.blobs.deletePrefix(`${checkKey(`runs/${userKeySegment(userId)}`)}/`);
  }
}

function archivedSummary(s: RunSummary): RunSummary & { archived: true } {
  const out = { ...s, live: false, archived: true as const };
  delete out.viewUrl;
  return out;
}

/** Whether a summary's run has ended (no process drives it any more). */
export const hasEnded = (s: RunSummary): boolean => !s.live && s.kind !== "live" && s.status !== "running";

async function mtimeOf(file: string): Promise<Date | undefined> {
  try {
    return (await stat(file)).mtime;
  } catch {
    return undefined;
  }
}

/** The regular files of a run folder (relative, `/`-separated), skipping every `worktrees` directory and symlinks. */
async function walk(root: string, rel = ""): Promise<string[]> {
  let items: Dirent[];
  try {
    items = await readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of items) {
    const p = rel ? `${rel}/${d.name}` : d.name;
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) {
      if (d.name === "worktrees") continue;
      out.push(...(await walk(root, p)));
    } else if (d.isFile()) out.push(p);
  }
  return out;
}

const fitsTar = (p: string): boolean => {
  try {
    tarArchive([{ path: p }], { uid: 0, gid: 0 });
    return true;
  } catch {
    return false;
  }
};

/**
 * Archives one run: writes its row and, once it has ended, its whole folder (minus `worktrees/`) as a blob.
 * False when the run does not exist. The archiver calls it on every change; later features call it at session end.
 */
export async function archiveRun(
  archive: RunArchive,
  user: User,
  home: RunHome,
  runId: string,
  opts: { dataDir: string; prs?: PrIndex },
): Promise<boolean> {
  const detail = await runDetail(home, runId, opts.dataDir);
  if (!detail) return false;
  delete detail.landed;
  const summary = detail.summary;
  if (opts.prs) attachPr(summary, opts.prs);
  const runDir = runDirOf(home, runId);
  const ended = hasEnded(summary);
  const endedAt = ended ? await mtimeOf(summary.type === "suite" ? runDir : path.join(runDir, "state.json")) : undefined;
  await archive.record(user, home.id, runId, {
    status: summary.status,
    ...(summary.createdAt ? { startedAt: summary.createdAt } : {}),
    ...(endedAt ? { endedAt: endedAt.toISOString() } : {}),
    ...(summary.pr?.url ? { prUrl: summary.pr.url } : {}),
    ...(detail.state ? { state: detail.state } : {}),
    summary,
  });
  if (!ended) return true;
  const entries: TarEntry[] = [];
  const skipped: string[] = [];
  for (const rel of await walk(runDir)) {
    if (!fitsTar(rel)) {
      skipped.push(rel);
      continue;
    }
    const full = path.join(runDir, ...rel.split("/"));
    try {
      const st = await stat(full);
      if (st.size > MAX_ARCHIVED_FILE) {
        skipped.push(rel);
        continue;
      }
      entries.push({ path: rel, content: await readFile(full), mode: 0o600 });
    } catch {
      // gone while walking
    }
  }
  const saved: DetailFile = { summary, state: detail.state, graph: detail.graph, tasks: detail.tasks, view: detail.view, skipped };
  entries.push({ path: DETAIL_FILE, content: Buffer.from(JSON.stringify(saved)), mode: 0o600 });
  await archive.saveFolder(user, home.id, runId, Readable.from([gzipTar(entries, { uid: 0, gid: 0 })]));
  return true;
}

export interface RunArchiverOptions {
  archive: RunArchive;
  store: Store;
  workspacesDir: string;
  dataDir: string;
  /** Default 10 000. */
  intervalMs?: number;
  /** The users whose runs are archived (their projects too); default the admin only. */
  users?: () => Promise<User[]>;
  /** Whether a workspace's runs belong to `user` (they made or opened the clone); default yes. A clone no user owns is skipped. */
  owns?: (user: User, workspaceId: string) => Promise<boolean>;
}

/** Polls every run of every home and archives the ones that changed (rows always, folders once ended). */
export class RunArchiver {
  private readonly opts: RunArchiverOptions;
  private readonly intervalMs: number;
  private readonly users: () => Promise<User[]>;
  private readonly owns: (user: User, workspaceId: string) => Promise<boolean>;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  /** The fingerprint archived last per `<home>/<run>`; empty after a restart, so every run is archived once again. */
  private readonly seen = new Map<string, string>();

  constructor(opts: RunArchiverOptions) {
    this.opts = opts;
    this.intervalMs = opts.intervalMs ?? 10_000;
    this.users = opts.users ?? (() => Promise.resolve([ADMIN_USER]));
    this.owns = opts.owns ?? (() => Promise.resolve(true));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** One poll; never overlaps a running one and never throws. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.poll()
      .catch(() => undefined)
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async poll(): Promise<void> {
    const { workspacesDir, dataDir, store } = this.opts;
    const users = await this.users();
    const clones: RunHome[] = (await listWorkspaces(workspacesDir)).map(workspaceHome);
    for (const user of users) {
      // Each user's runs go to their own archive: the clones they own and their own projects.
      const homes: RunHome[] = [];
      for (const home of clones) if (await this.owns(user, home.id).catch(() => false)) homes.push(home);
      for (const p of projectsOf((await store.forUser(user)).get())) {
        const home = projectHome(workspacesDir, p.id, p);
        if (home) homes.push(home);
      }
      const prs = (await store.forUser(user)).get().prs;
      for (const home of homes) await this.archiveHome(user, home, prs, dataDir);
    }
  }

  private async archiveHome(owner: User, home: RunHome, prs: PrIndex, dataDir: string): Promise<void> {
    const runs = await listHomeRuns(home, prs, dataDir);
    for (const run of runs) {
      const dir = runDirOf(home, run.id);
      const mtime = await mtimeOf(run.type === "suite" ? dir : path.join(dir, "state.json"));
      const fp = `${run.status}|${run.kind}|${run.live}|${mtime?.getTime() ?? ""}`;
      const key = `${owner.id}\0${home.id}/${run.id}`;
      if (this.seen.get(key) === fp) continue;
      try {
        await archiveRun(this.opts.archive, owner, home, run.id, { dataDir, prs });
        this.seen.set(key, fp);
      } catch {
        // retried on the next tick
      }
    }
  }
}
