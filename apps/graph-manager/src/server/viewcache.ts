import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ViewState } from "graph-execution/api";
import { z } from "zod";
import { isRunId, listWorkspaceRuns, livePage, runDirOf } from "./runs.js";
import { listWorkspaces } from "./workspaces.js";

/**
 * A compact copy of a live run page's view model (`GET <page>/state`), kept under `<dataDir>/views/` so a finished
 * run keeps its task times, line counts and review results after its page closes. The engine keeps them in memory only.
 */

export type CachedNode = {
  status: string;
  attempt?: number;
  attempts?: number;
  startedAt?: number;
  endedAt?: number;
  added?: number;
  deleted?: number;
  files?: number;
  round?: number;
  rounds?: number;
  error?: string;
};

export type CachedView = {
  version: 1;
  runId: string;
  savedAt: string;
  /** The run's summary is present: the run is over. */
  final: boolean;
  phase: { phase: string; round?: number; fixPasses?: number; humanRound?: number };
  nodes: Record<string, CachedNode>;
  agents: Partial<Record<"gateFixer" | "reviewer" | "tester" | "fixer", CachedNode>>;
  gate?: CachedNode;
  merge?: CachedNode;
  review?: { round: number; blocking: number; decision?: string };
  summary?: {
    exitCode: number;
    fixPasses: number;
    findings: number;
    abort?: { step: string; message: string };
    merge?: { target: string; ok: boolean; reason?: string };
  };
  testPlan?: { cases: number; pass: number; fail: number; blocked: number };
};

const AGENTS = ["gateFixer", "reviewer", "tester", "fixer"] as const;
const ERROR_MAX = 500;
const WS_ID = /^[A-Za-z0-9._~-]+$/;

const num = z.number().optional().catch(undefined);
const str = z.string().optional().catch(undefined);

// Tolerant: the page's shape belongs to the engine and may change; unknown fields pass, broken optional ones drop.
const nodeSchema = z
  .object({
    status: z.string(),
    attempt: num,
    attempts: num,
    round: num,
    rounds: num,
    startedAt: num,
    endedAt: num,
    changes: z
      .object({ total: z.object({ added: z.number(), deleted: z.number(), files: z.number() }).passthrough() })
      .passthrough()
      .optional()
      .catch(undefined),
    testPlan: z
      .object({ cases: z.array(z.object({ verdict: z.string() }).passthrough()) })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

const optionalNode = nodeSchema.optional().catch(undefined);

const snapshotSchema = z
  .object({
    runId: z.string(),
    nodes: z.record(z.string(), nodeSchema),
    agents: z.record(z.string(), nodeSchema).optional().catch(undefined),
    gate: optionalNode,
    merge: optionalNode,
    phase: z
      .object({ phase: z.string(), round: num, fixPasses: num, humanRound: num })
      .passthrough()
      .catch({ phase: "unknown" }),
    review: z
      .object({ round: z.number(), blocking: z.array(z.unknown()).catch([]), decision: str })
      .passthrough()
      .optional()
      .catch(undefined),
    summary: z
      .object({
        exitCode: z.number(),
        fixPasses: z.number().catch(0),
        reports: z.array(z.object({ findings: z.array(z.unknown()).catch([]) }).passthrough()).catch([]),
        abort: z.object({ step: z.string(), message: z.string() }).passthrough().optional().catch(undefined),
        merge: z.object({ target: z.string(), ok: z.boolean(), reason: str }).passthrough().optional().catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
    failures: z
      .record(z.string(), z.object({ error: z.string() }).passthrough())
      .optional()
      .catch(undefined),
  })
  .passthrough();

type SnapshotNode = z.infer<typeof nodeSchema>;

function compactNode(n: SnapshotNode, error?: string): CachedNode {
  const out: CachedNode = { status: n.status };
  if (n.attempt !== undefined) out.attempt = n.attempt;
  if (n.attempts !== undefined) out.attempts = n.attempts;
  if (n.startedAt !== undefined) out.startedAt = n.startedAt;
  if (n.endedAt !== undefined) out.endedAt = n.endedAt;
  if (n.changes) {
    out.added = n.changes.total.added;
    out.deleted = n.changes.total.deleted;
    out.files = n.changes.total.files;
  }
  if (n.round !== undefined) out.round = n.round;
  if (n.rounds !== undefined) out.rounds = n.rounds;
  if (error !== undefined) out.error = error.length > ERROR_MAX ? error.slice(0, ERROR_MAX) : error;
  return out;
}

/** The compact view of a `GET /state` snapshot; undefined when it isn't one. Drops events, file lists and the summary text. */
export function toCachedView(snapshot: unknown, now: Date = new Date()): CachedView | undefined {
  const parsed = snapshotSchema.safeParse(snapshot);
  if (!parsed.success) return undefined;
  const s = parsed.data;
  const errorOf = (id: string): string | undefined => s.failures?.[id]?.error;

  const nodes: Record<string, CachedNode> = {};
  for (const [id, n] of Object.entries(s.nodes)) nodes[id] = compactNode(n, errorOf(id));

  const agents: CachedView["agents"] = {};
  for (const a of AGENTS) {
    const n = s.agents?.[a];
    if (n) agents[a] = compactNode(n, errorOf(`@${a}`));
  }

  const { phase, round, fixPasses, humanRound } = s.phase;
  const view: CachedView = {
    version: 1,
    runId: s.runId,
    savedAt: now.toISOString(),
    final: s.summary !== undefined,
    phase: { phase, ...(round !== undefined && { round }), ...(fixPasses !== undefined && { fixPasses }), ...(humanRound !== undefined && { humanRound }) },
    nodes,
    agents,
  };
  if (s.gate) view.gate = compactNode(s.gate, errorOf("@gate"));
  if (s.merge) view.merge = compactNode(s.merge, errorOf("@merge"));
  if (s.review) {
    view.review = { round: s.review.round, blocking: s.review.blocking.length };
    if (s.review.decision !== undefined) view.review.decision = s.review.decision;
  }
  if (s.summary) {
    const sum = s.summary;
    view.summary = {
      exitCode: sum.exitCode,
      fixPasses: sum.fixPasses,
      findings: sum.reports.reduce((total, r) => total + r.findings.length, 0),
    };
    if (sum.abort) view.summary.abort = { step: sum.abort.step, message: sum.abort.message };
    if (sum.merge) {
      view.summary.merge = { target: sum.merge.target, ok: sum.merge.ok };
      if (sum.merge.reason !== undefined) view.summary.merge.reason = sum.merge.reason;
    }
  }
  const cases = s.agents?.tester?.testPlan?.cases;
  if (cases) {
    const count = (v: string): number => cases.filter((c) => c.verdict === v).length;
    view.testPlan = { cases: cases.length, pass: count("pass"), fail: count("fail"), blocked: count("blocked") };
  }
  return view;
}

/** `<dataDir>/views/<wsId>/<runId>.json`; throws on an id that could escape that folder. */
export function viewPath(dataDir: string, wsId: string, runId: string): string {
  if (!WS_ID.test(wsId) || wsId === "." || wsId === "..") throw new Error(`invalid workspace id: ${wsId}`);
  if (!isRunId(runId)) throw new Error(`invalid run id: ${runId}`);
  return path.join(dataDir, "views", wsId, `${runId}.json`);
}

const cachedViewSchema = z
  .object({ version: z.literal(1), runId: z.string(), savedAt: z.string(), final: z.boolean(), nodes: z.record(z.string(), z.unknown()) })
  .passthrough();

/** The cached view of a run; undefined when there is none, the ids are invalid or the file is unreadable. */
export async function readCachedView(dataDir: string, wsId: string, runId: string): Promise<CachedView | undefined> {
  try {
    const parsed = cachedViewSchema.safeParse(JSON.parse(await readFile(viewPath(dataDir, wsId, runId), "utf8")));
    return parsed.success ? (parsed.data as unknown as CachedView) : undefined;
  } catch {
    return undefined;
  }
}

export interface ViewCacheOptions {
  dataDir: string;
  workspacesDir: string;
  /** Default 3000. */
  intervalMs?: number;
  fetch?: typeof fetch;
}

/** Polls every live run page and keeps its compact view on disk. */
export class ViewCache {
  private readonly dataDir: string;
  private readonly workspacesDir: string;
  private readonly intervalMs: number;
  private readonly fetchFn: typeof fetch;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  /** The last content written per file, minus `savedAt`, to skip unchanged writes. */
  private readonly last = new Map<string, string>();

  constructor(opts: ViewCacheOptions) {
    this.dataDir = opts.dataDir;
    this.workspacesDir = opts.workspacesDir;
    this.intervalMs = opts.intervalMs ?? 3000;
    this.fetchFn = opts.fetch ?? fetch;
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

  /** One poll of every live run; never overlaps a running one and never throws. */
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
    const workspaces = await listWorkspaces(this.workspacesDir);
    await Promise.all(
      workspaces.map(async (ws) => {
        const runs = (await listWorkspaceRuns(ws)).filter((r) => r.live && r.type === "run");
        await Promise.all(runs.map((r) => this.save(ws.id, r.id, runDirOf(ws, r.id)).catch(() => undefined)));
      }),
    );
  }

  private async save(wsId: string, runId: string, runDir: string): Promise<void> {
    const page = await livePage(runDir);
    if (!page) return;
    const base = page.url.endsWith("/") ? page.url : `${page.url}/`;
    const res = await this.fetchFn(`${base}state`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return;
    // The engine's `/state` body: its `ViewState` plus run metadata; validated by `toCachedView`.
    const snapshot = (await res.json()) as Partial<ViewState> & { runId?: string };
    const view = toCachedView(snapshot);
    if (!view) return;
    const file = viewPath(this.dataDir, wsId, runId);
    const key = JSON.stringify({ ...view, savedAt: "" });
    if (this.last.get(file) === key) return;
    if (!this.last.has(file)) {
      // After a restart: compare with what is already on disk.
      const prev = await readFile(file, "utf8")
        .then((text) => JSON.stringify({ ...(JSON.parse(text) as object), savedAt: "" }))
        .catch(() => undefined);
      if (prev === key) {
        this.last.set(file, key);
        return;
      }
    }
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(view)}\n`);
    await rename(tmp, file);
    this.last.set(file, key);
  }
}
