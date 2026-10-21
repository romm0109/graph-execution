import { readdir, readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { rangeChanges } from "../git/git.js";
import { loadTasks } from "../graph/load.js";
import { executionLayers } from "../graph/validate.js";
import { allComments, commentFindingId, commentOutcomes, HumanReviewError, HumanReviewStore, loadHumanRound, openComments } from "../review/human.js";
import type { Finding } from "../review/report.js";
import type { NodeChanges, RunEmitter } from "../runner/events.js";
import { AGENT_NODE } from "../runner/nodes.js";
import type { RetryHub } from "../runner/retry-hub.js";
import { type ReviewState, type RunState, stateSchema } from "../state/state.js";
import { finalFileDiff, readJson } from "../web/server.js";
import { worktreeFileDiff } from "../runner/changes.js";
import { changesOf, suiteChangeSources } from "./changes.js";
import type { ControlResult, SuiteControl } from "./control.js";
import { featureRunDir, SUITE_FILE, suiteStateSchema } from "./state.js";

export interface SuiteServerOptions {
  suiteDir: string;
  control: SuiteControl;
  pageFile?: string;
  /** Abort pressed while the suite runs; defaults to a SIGINT to this process. */
  onAbort?: () => void;
  /** Called after Close, once the server is down. */
  onClose?: () => void;
  isRunning: () => boolean;
  /** The human review before the single apply: `hub` takes the decision, `events` tell when the suite waits. */
  review?: { hub: RetryHub; events: RunEmitter; suiteDir: string; repo: string };
}

export interface SuiteServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

interface FeatureView {
  name: string;
  status: string;
  share?: number;
  runId: string;
  tasks: { id: string; status: string; attempts: number }[];
  /** The feature's task DAG, so the page draws it like a run's graph: task ids per layer and dependencies per id. */
  layers: string[][];
  parents: Record<string, string[]>;
  reviewPhase?: string;
  reviewRound?: number;
  /** The feature run's review loop, so the page draws its validate, reviewer, tester and fixer nodes. */
  review?: ReviewState;
  /** Per fixer that ran: still working (`running`, its pass has no end commit yet) or `done`. The page shows the validation fixer only once it ran, like the run page. */
  fixers?: { fixer?: "running" | "done"; gateFixer?: "running" | "done" };
  runStatus?: string;
}

/** The task DAG of a feature's task folder; an unreadable folder gives no layers (the page falls back to the state's tasks). */
async function featureGraph(tasksDir: string): Promise<{ layers: string[][]; parents: Record<string, string[]> }> {
  try {
    const tasks = await loadTasks(tasksDir);
    return { layers: executionLayers(tasks).map((l) => l.map((t) => t.id)), parents: Object.fromEntries(tasks.map((t) => [t.id, [...t.dependencies]])) };
  } catch {
    return { layers: [], parents: {} };
  }
}

const json = (res: http.ServerResponse, status: number, body: object): http.ServerResponse =>
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));

const NOT_WAITING = { error: "the suite is not waiting for your review" };

const newCommentSchema = z.object({
  file: z.string().min(1).optional(),
  line: z.number().int().min(1).optional(),
  snippet: z.string().max(2000).optional(),
  body: z.string().trim().min(1).max(10_000),
  liveCheck: z.boolean().optional(),
});
const patchCommentSchema = z.object({ body: z.string().trim().min(1).max(10_000).optional(), liveCheck: z.boolean().optional() });
const reopenSchema = z.object({ followUp: z.string().max(10_000).optional() });

const REFUSALS: Record<string, string> = {
  not_failed: "the feature is not failed",
  not_ready: "not available now",
  unknown: "unknown feature",
};

/** The one-page web view of a running suite: lanes read from `suite.json` and the feature runs' `state.json`. */
export async function createSuiteServer(opts: SuiteServerOptions): Promise<SuiteServer> {
  const { suiteDir, control } = opts;
  const pageFile = opts.pageFile ?? fileURLToPath(new URL("./page.html", import.meta.url));
  let port = 0;

  const human = opts.review;
  /** Set from the review phase's events while the suite waits for the human. */
  let waiting: { round: number; reviewRound?: number; blocking: Finding[] } | undefined;
  human?.events.on("review:waiting", (w) => {
    waiting = { round: w.round, reviewRound: w.reviewRound, blocking: w.blocking };
  });
  human?.events.on("review:decided", () => {
    waiting = undefined;
  });
  const comments = human ? new HumanReviewStore(human.suiteDir) : undefined;

  /** The findings that still block: those of resolved comments do not. */
  const blockingNow = async (): Promise<Finding[]> => {
    if (!human || !waiting) return [];
    const resolved = new Set((await allComments(human.suiteDir, waiting.round)).filter((c) => c.status === "resolved").map((c) => commentFindingId(c.id)));
    return waiting.blocking.filter((f) => !resolved.has(f.id));
  };

  const commentWrite = async <T extends z.ZodTypeAny>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    schema: T,
    act: (input: z.infer<T>) => Promise<unknown>,
    status: number,
  ): Promise<void> => {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      return void json(res, 400, { error: err instanceof Error ? err.message : "bad request body" });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) return void json(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid comment" });
    const input = parsed.data as { file?: string; line?: number };
    if (input.line !== undefined && input.file === undefined) return void json(res, 400, { error: "line needs a file" });
    try {
      json(res, status, (await act(parsed.data)) as object);
    } catch (err) {
      if (!(err instanceof HumanReviewError)) throw err;
      json(res, err.kind === "unknown" ? 404 : 400, { error: err.message });
    }
  };

  /** `/api/review/...`; the caller checked the method against the route. */
  const reviewRoute = async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string, method: string): Promise<void> => {
    if (!human || !comments || !waiting) return void json(res, 409, NOT_WAITING);
    const current = waiting;
    const hub = human.hub;
    if (pathname === "/api/review") {
      const base = { round: current.round, blocking: await blockingNow() };
      const data = await loadHumanRound(human.suiteDir, current.round);
      if (!data) return void json(res, 200, base);
      const [files, all] = await Promise.all([rangeChanges(human.repo, data.diffBase, data.diffHead), allComments(human.suiteDir, current.round)]);
      const outcomes = current.reviewRound === undefined ? {} : await commentOutcomes(human.suiteDir, current.reviewRound, all);
      return void json(res, 200, { ...base, diffBase: data.diffBase, diffHead: data.diffHead, files, comments: all, outcomes });
    }
    if (pathname === "/api/review/diff") {
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      const file = params.get("file");
      const round = Number(params.get("round") ?? current.round);
      const data = Number.isInteger(round) && round >= 1 && round <= current.round ? await loadHumanRound(human.suiteDir, round) : undefined;
      if (!data || file === null) return void json(res, 400, { error: "unknown file" });
      // Only paths from that round's own diff reach git.
      const files = await rangeChanges(human.repo, data.diffBase, data.diffHead);
      if (!files.some((f) => f.path === file)) return void json(res, 400, { error: "unknown file" });
      return void json(res, 200, await finalFileDiff(human.repo, data.diffBase, data.diffHead, file));
    }
    if (pathname === "/api/review/comments") return commentWrite(req, res, newCommentSchema, (input) => comments.add(input), 201);
    if (pathname === "/api/review/apply") {
      let body: unknown;
      try {
        body = await readJson(req);
      } catch (err) {
        return void json(res, 400, { error: err instanceof Error ? err.message : "bad request body" });
      }
      const force = typeof body === "object" && body !== null && (body as { force?: unknown }).force === true;
      if ((await blockingNow()).length > 0 && !force) return void json(res, 409, { error: "open findings: pass force to apply anyway" });
      return void (hub.decide({ review: "apply", force }).ok ? json(res, 200, { ok: true }) : json(res, 409, NOT_WAITING));
    }
    if (pathname === "/api/review/changes") {
      if (openComments(await allComments(human.suiteDir, current.round)).length === 0) {
        return void json(res, 409, { error: "write or reopen a comment first" });
      }
      return void (hub.decide({ review: "changes" }).ok ? json(res, 200, { ok: true }) : json(res, 409, NOT_WAITING));
    }
    if (pathname === "/api/review/drop") return void (hub.decide({ review: "drop" }).ok ? json(res, 200, { ok: true }) : json(res, 409, NOT_WAITING));
    // /api/review/comments/<id>[/resolve|/reopen]
    const m = /^\/api\/review\/comments\/([^/]+)(?:\/(resolve|reopen))?$/.exec(pathname);
    let id: string;
    try {
      id = decodeURIComponent(m![1]!);
    } catch {
      return void json(res, 404, { error: "unknown comment" });
    }
    try {
      if (m![2] === "resolve") return void json(res, 200, await comments.resolve(id));
      if (m![2] === "reopen") return commentWrite(req, res, reopenSchema, (input) => comments.reopen(id, input.followUp), 200);
      if (method === "PUT") return commentWrite(req, res, patchCommentSchema, (patch) => comments.edit(id, patch), 200);
      await comments.remove(id);
      json(res, 200, { ok: true });
    } catch (err) {
      if (!(err instanceof HumanReviewError)) throw err;
      json(res, err.kind === "unknown" ? 404 : 400, { error: err.message });
    }
  };

  const readSuite = async (): Promise<ReturnType<typeof suiteStateSchema.parse> | undefined> => {
    try {
      return suiteStateSchema.parse(JSON.parse(await readFile(path.join(suiteDir, SUITE_FILE), "utf8")));
    } catch {
      return undefined;
    }
  };

  /** Task folders do not change during a suite (resume refuses changed ones), so each is read once. */
  const graphs = new Map<string, Promise<{ layers: string[][]; parents: Record<string, string[]> }>>();
  const repo = opts.review?.repo ?? path.resolve(suiteDir, "..", "..");
  const readRun = async (runId: string): Promise<RunState | undefined> => {
    try {
      const parsed = stateSchema.safeParse(JSON.parse(await readFile(path.join(featureRunDir(suiteDir, runId), "state.json"), "utf8")));
      return parsed.success ? parsed.data : undefined;
    } catch {
      // Not started yet, or mid-write.
      return undefined;
    }
  };
  const runsOf = async (suite: ReturnType<typeof suiteStateSchema.parse>): Promise<Map<string, RunState>> => {
    const runs = new Map<string, RunState>();
    for (const f of suite.features) {
      const run = await readRun(f.runId);
      if (run) runs.set(f.name, run);
    }
    return runs;
  };
  const featureView = async (f: ReturnType<typeof suiteStateSchema.parse>["features"][number], run: RunState | undefined): Promise<FeatureView> => {
    if (!graphs.has(f.tasksDir)) graphs.set(f.tasksDir, featureGraph(f.tasksDir));
    const view: FeatureView = { name: f.name, status: f.status, share: f.share, runId: f.runId, tasks: [], ...(await graphs.get(f.tasksDir)!) };
    if (run) {
      view.tasks = Object.entries(run.tasks).map(([id, t]) => ({ id, status: t.status, attempts: t.attempts }));
      view.reviewPhase = run.review.phase;
      view.reviewRound = run.review.round;
      view.review = run.review;
      const fixer = (node: string): "running" | "done" | undefined => {
        const range = run.fixRanges?.[node];
        return range && (range.to ? "done" : "running");
      };
      view.fixers = { fixer: fixer(AGENT_NODE.fixer), gateFixer: fixer(AGENT_NODE.gateFixer) };
      view.runStatus = run.status;
    }
    return view;
  };

  const answer = (res: http.ServerResponse, result: ControlResult): void => {
    if (result.ok) return void json(res, 200, { ok: true });
    json(res, 409, { error: REFUSALS[result.reason] ?? "refused" });
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host ?? "")) return void res.writeHead(421).end("Misdirected Request");
    const origin = req.headers.origin;
    if (req.method !== "GET" && req.method !== "HEAD" && origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) {
      return void res.writeHead(403).end("Forbidden");
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const method = req.method ?? "GET";

    // Spec route is by run id with a node id; the by-name route stays for the page. A retry resumes the whole feature run.
    const retry = /^\/api\/features\/([^/]+)\/retry(?:\/[^/]+)?$/.exec(pathname);
    const events = /^\/api\/features\/([^/]+)\/events$/.exec(pathname);
    const reviewMethod = ((): string | undefined => {
      if (!human) return undefined;
      if (pathname === "/api/review" || pathname === "/api/review/diff") return "GET";
      if (["/api/review/comments", "/api/review/apply", "/api/review/changes", "/api/review/drop"].includes(pathname)) return "POST";
      const m = /^\/api\/review\/comments\/[^/]+(\/(resolve|reopen))?$/.exec(pathname);
      if (!m) return undefined;
      return m[1] ? "POST" : method === "DELETE" ? "DELETE" : "PUT";
    })();
    if (reviewMethod) {
      if (method !== reviewMethod) return void res.writeHead(405).end("Method Not Allowed");
      return await reviewRoute(req, res, pathname, method);
    }
    const allowedMethod =
      pathname === "/" || pathname === "/api/suite" || pathname === "/api/changes" || events ? "GET" : retry || ["/api/integration/start", "/api/integration/retry", "/api/abort", "/close"].includes(pathname) ? "POST" : undefined;
    if (!allowedMethod) return void res.writeHead(404).end("Not Found");
    if (method !== allowedMethod) return void res.writeHead(405).end("Method Not Allowed");

    if (pathname === "/") {
      const html = await readFile(pageFile);
      return void res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
    }
    if (pathname === "/api/suite") {
      const suite = await readSuite();
      if (!suite) return void json(res, 503, { error: "suite state is not readable" });
      const runs = await runsOf(suite);
      const features = await Promise.all(suite.features.map((f) => featureView(f, runs.get(f.name))));
      const { sources, conflicts } = await suiteChangeSources(repo, suiteDir, suite, runs);
      const changes: Record<string, NodeChanges> = {};
      await Promise.all([...sources].map(async ([key, source]) => {
        const c = await changesOf(source);
        if (c) changes[key] = c;
      }));
      return void json(res, 200, { suite, features, changes, conflicts, allowed: control.allowed, running: opts.isRunning(), reviewWaiting: waiting !== undefined });
    }
    if (pathname === "/api/changes") {
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      const node = params.get("node") ?? "";
      const file = params.get("file") ?? "";
      const suite = await readSuite();
      const source = suite && (await suiteChangeSources(repo, suiteDir, suite, await runsOf(suite))).sources.get(node);
      if (!source) return void json(res, 404, { error: "no changes for this node" });
      // Only paths from the node's own change list reach git.
      if (!(await changesOf(source))?.files.some((c) => c.path === file)) return void json(res, 400, { error: "unknown file" });
      try {
        return void json(res, 200, source.kind === "range" ? await finalFileDiff(source.repo, source.from, source.to, file) : await worktreeFileDiff(source.worktree, source.base, file));
      } catch {
        return void json(res, 404, { error: "the diff is gone" });
      }
    }
    if (retry || events) {
      let key: string;
      try {
        key = decodeURIComponent((retry ?? events)![1]!);
      } catch {
        return void json(res, 404, { error: "unknown feature" });
      }
      const suite = await readSuite();
      const feature = suite?.features.find((f) => f.runId === key || f.name === key);
      if (!feature) return void json(res, 404, { error: `unknown feature ${key}` });
      if (retry) return answer(res, control.retryFeature(feature.name));
      const runDir = featureRunDir(suiteDir, feature.runId);
      const view = await featureView(feature, await readRun(feature.runId));
      const logs: { label: string; tail: string }[] = [];
      for (const file of (await readdir(path.join(runDir, "logs")).catch(() => [] as string[])).sort()) {
        const text = await readFile(path.join(runDir, "logs", file), "utf8").catch(() => "");
        logs.push({ label: file.replace(/\.log$/, ""), tail: text.slice(-4000) });
      }
      return void json(res, 200, { runId: feature.runId, feature: view, logs });
    }
    if (pathname === "/api/integration/start") return answer(res, control.startIntegration());
    if (pathname === "/api/integration/retry") return answer(res, control.retryIntegration());
    if (pathname === "/api/abort") {
      if (!opts.isRunning()) return void json(res, 409, { error: "the suite has ended" });
      json(res, 200, { ok: true });
      (opts.onAbort ?? (() => void process.kill(process.pid, "SIGINT")))();
      return;
    }
    // /close
    if (opts.isRunning()) return void json(res, 409, { error: "the suite is still going" });
    // Close only after the response is flushed, or the browser sees a network error.
    res.once("finish", () => {
      void closeServer().then(opts.onClose);
    });
    json(res, 200, { ok: true });
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;

  function closeServer(): Promise<void> {
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  return { url: `http://127.0.0.1:${port}/`, port, close: closeServer };
}
