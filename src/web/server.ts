import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { rangeChanges, rangeFileDiff } from "../git/git.js";
import { allComments, commentFindingId, commentOutcomes, HumanReviewError, HumanReviewStore, loadHumanRound, openComments } from "../review/human.js";
import { z } from "zod";
import { capDiff, type ChangeTracker, type FileDiff } from "../runner/changes.js";
import { execa } from "execa";
import type { RetryHub } from "../runner/retry-hub.js";
import { graphModel } from "../ui/model.js";
import type { Finding } from "../review/report.js";
import type { RunStore } from "../ui/store.js";
import { summaryContent } from "../ui/Summary.js";

export interface WebMeta {
  /** Task ids per execution layer. */
  layers: string[][];
  parents: Record<string, readonly string[]>;
  mergeTarget?: string;
  runId: string;
  provider: string;
  startedAt: number;
}

const NOT_WAITING = { error: "the run is not waiting for your review" };

/** Reads a JSON request body; an empty body is `{}`. Throws when it is over `limit` bytes or not JSON. */
export async function readJson(req: http.IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

/** The final diff of one file, with the same binary and size handling as a node's diff. */
async function finalFileDiff(repo: string, from: string, to: string, file: string): Promise<FileDiff> {
  const { stdout } = await execa("git", ["--no-optional-locks", "diff", "--no-renames", "--numstat", from, to, "--", file], { cwd: repo });
  if (stdout.trim().startsWith("-\t-")) return { path: file, diff: "", truncated: false, binary: true };
  return capDiff(file, await rangeFileDiff(repo, from, to, file));
}

export interface WebServerOptions {
  store: RunStore;
  meta: WebMeta;
  pageFile?: URL | string;
  /** `POST /abort` while the run is going: same effect as Ctrl+C. */
  onAbort(): void;
  /** `POST /close` after the run ended, once the response is sent and the server is closing. */
  onClose(): void;
  /** `POST /retry/<id>`: re-runs a failed node while the run waits. */
  retry?: Pick<RetryHub, "retryNode"> & Partial<Pick<RetryHub, "mergeNow">>;
  /** `POST /review/apply` and `/review/drop`: answer the run's wait for the human's review. */
  review?: Pick<RetryHub, "decide">;
  /** `GET /changes/<id>?file=`: diff text of a node's changed file. */
  changes?: Pick<ChangeTracker, "fileDiff">;
  /** The final diff and the human's comments, for `/review/diff` and `/review/comments`. */
  human?: { runDir: string; repo: string };
}

export interface WebServer {
  url: string;
  port: number;
  close(): Promise<void>;
  /** A fatal error after the server is up: the page shows it and allows Close. */
  setFatal(fatal: { message: string; hint?: string }): void;
  server: http.Server;
}

/** At most one `state` event per this many ms per client. */
const SSE_THROTTLE_MS = 100;
const PING_MS = 15_000;

export async function createWebServer({
  store,
  meta,
  pageFile = new URL("./page.html", import.meta.url),
  onAbort,
  onClose,
  retry,
  review: reviewHub,
  changes,
  human,
}: WebServerOptions): Promise<WebServer> {
  const clients = new Set<http.ServerResponse>();
  let port = 0;
  let fatal: { message: string; hint?: string } | undefined;

  const snapshot = (): string => {
    const state = store.getState();
    const model = graphModel({ layers: meta.layers, parents: meta.parents, state, mergeTarget: meta.mergeTarget });
    return JSON.stringify({
      ...state,
      graph: {
        nodes: [...model.nodes].map(([id, n]) => ({ id, title: n.title, view: n.view })),
        layers: model.layers,
        parents: model.parents,
      },
      runId: meta.runId,
      provider: meta.provider,
      mergeTarget: meta.mergeTarget,
      startedAt: meta.startedAt,
      fatal,
      summaryContent: state.summary ? summaryContent(state.summary) : undefined,
    });
  };

  type Route = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;
  const json = (res: http.ServerResponse, status: number, body: object): http.ServerResponse =>
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
  const routes: Record<string, Route> = {
    "GET /": async (_req, res) => {
      const html = await readFile(pageFile);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
    },
    "GET /state": (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(snapshot());
    },
    "GET /events": (req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      const send = (): void => void res.write(`event: state\ndata: ${snapshot()}\n\n`);
      send();
      clients.add(res);
      let timer: NodeJS.Timeout | undefined;
      let last = 0;
      const unsubscribe = store.subscribe(() => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          last = Date.now();
          send();
        }, Math.max(0, SSE_THROTTLE_MS - (Date.now() - last)));
      });
      const ping = setInterval(() => res.write(": ping\n\n"), PING_MS);
      req.on("close", () => {
        unsubscribe();
        clearInterval(ping);
        if (timer) clearTimeout(timer);
        clients.delete(res);
      });
    },
    "POST /abort": (_req, res) => {
      if (store.getState().summary !== undefined || fatal) return void json(res, 409, { error: "the run has ended" });
      onAbort();
      json(res, 200, { ok: true });
    },
    "POST /merge": (_req, res) => {
      const result = store.getState().mergeable && retry?.mergeNow ? retry.mergeNow() : undefined;
      if (!result || !result.ok) return void json(res, 409, { error: "there is nothing to merge now" });
      json(res, 200, { ok: true });
    },
    "GET /review": async (_req, res) => {
      const review = store.getState().review;
      if (!review?.waiting) return void json(res, 409, NOT_WAITING);
      const base = { round: review.round, blocking: await refreshBlocking() };
      if (!human) return void json(res, 200, base);
      const data = await loadHumanRound(human.runDir, review.round);
      if (!data) return void json(res, 200, base);
      const [files, comments] = await Promise.all([
        rangeChanges(human.repo, data.diffBase, data.diffHead),
        allComments(human.runDir, review.round),
      ]);
      const outcomes = review.reviewRound === undefined ? {} : await commentOutcomes(human.runDir, review.reviewRound, comments);
      json(res, 200, { ...base, diffBase: data.diffBase, diffHead: data.diffHead, files, comments, outcomes });
    },
    "GET /review/diff": async (req, res) => {
      const review = store.getState().review;
      if (!review?.waiting) return void json(res, 409, NOT_WAITING);
      if (!human) return void json(res, 404, { error: "no diff available" });
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      const file = params.get("file");
      const round = Number(params.get("round") ?? review.round);
      const data = Number.isInteger(round) && round >= 1 && round <= review.round ? await loadHumanRound(human.runDir, round) : undefined;
      if (!data || file === null) return void json(res, 400, { error: "unknown file" });
      // Only paths from that round's own diff reach git.
      const files = await rangeChanges(human.repo, data.diffBase, data.diffHead);
      if (!files.some((f) => f.path === file)) return void json(res, 400, { error: "unknown file" });
      json(res, 200, await finalFileDiff(human.repo, data.diffBase, data.diffHead, file));
    },
    "POST /review/comments": async (req, res) => {
      if (!store.getState().review?.waiting) return void json(res, 409, NOT_WAITING);
      if (!human) return void json(res, 404, { error: "comments are not available" });
      await commentWrite(req, res, newCommentSchema, (input) => humanStore(human.runDir).add(input), 201);
    },
    "POST /review/apply": async (req, res) => {
      const review = store.getState().review;
      if (!review?.waiting || !reviewHub) return void json(res, 409, NOT_WAITING);
      let body: unknown;
      try {
        body = await readJson(req);
      } catch (err) {
        return void json(res, 400, { error: err instanceof Error ? err.message : "bad request body" });
      }
      const force = typeof body === "object" && body !== null && (body as { force?: unknown }).force === true;
      if ((await refreshBlocking()).length > 0 && !force) {
        return void json(res, 409, { error: "open findings: pass force to apply anyway" });
      }
      const result = reviewHub.decide({ review: "apply", force });
      if (!result.ok) return void json(res, 409, NOT_WAITING);
      json(res, 200, { ok: true });
    },
    "POST /review/changes": async (_req, res) => {
      const review = store.getState().review;
      if (!review?.waiting || !reviewHub) return void json(res, 409, NOT_WAITING);
      if (!human || openComments(await allComments(human.runDir, review.round)).length === 0) {
        return void json(res, 409, { error: "write or reopen a comment first" });
      }
      const result = reviewHub.decide({ review: "changes" });
      if (!result.ok) return void json(res, 409, NOT_WAITING);
      json(res, 200, { ok: true });
    },
    "POST /review/drop": (_req, res) => {
      if (!store.getState().review?.waiting || !reviewHub) return void json(res, 409, NOT_WAITING);
      const result = reviewHub.decide({ review: "drop" });
      if (!result.ok) return void json(res, 409, NOT_WAITING);
      json(res, 200, { ok: true });
    },
    "POST /close": (_req, res) => {
      if (store.getState().summary === undefined && !fatal) return void json(res, 409, { error: "the run is still going" });
      // Close only after the response is flushed, or the browser sees a network error.
      res.once("finish", () => {
        void closeServer().then(onClose);
      });
      json(res, 200, { ok: true });
    },
  };

  /** The human decides: findings of resolved comments stop blocking. Updates the snapshot and returns the open ones. */
  const refreshBlocking = async (): Promise<Finding[]> => {
    const review = store.getState().review;
    if (!review) return [];
    if (human) {
      const all = await allComments(human.runDir, review.round);
      const resolved = new Set(all.filter((c) => c.status === "resolved").map((c) => commentFindingId(c.id)));
      store.setReviewResolved(resolved);
      const open = openComments(all);
      const stillBlocking = new Set((store.getState().review?.blocking ?? []).map((f) => f.id));
      // Earlier comments the reviewer no longer flags; nothing is "addressed" before a human round ran.
      const addressed = review.round > 1 ? open.filter((c) => !stillBlocking.has(commentFindingId(c.id))).length : 0;
      store.setReviewResolved(resolved, { total: all.length, open: open.length, addressed });
    }
    return store.getState().review?.blocking ?? [];
  };

  const stores = new Map<string, HumanReviewStore>();
  const humanStore = (runDir: string): HumanReviewStore => {
    let found = stores.get(runDir);
    if (!found) stores.set(runDir, (found = new HumanReviewStore(runDir)));
    return found;
  };
  const newCommentSchema = z.object({
    file: z.string().min(1).optional(),
    line: z.number().int().min(1).optional(),
    snippet: z.string().max(2000).optional(),
    body: z.string().trim().min(1).max(10_000),
    liveCheck: z.boolean().optional(),
  });
  const patchCommentSchema = z.object({ body: z.string().trim().min(1).max(10_000).optional(), liveCheck: z.boolean().optional() });
  const reopenSchema = z.object({ followUp: z.string().max(10_000).optional() });
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
      const result = (await act(parsed.data)) as object;
      await refreshBlocking();
      json(res, status, result);
    } catch (err) {
      if (!(err instanceof HumanReviewError)) throw err;
      json(res, err.kind === "unknown" ? 404 : 400, { error: err.message });
    }
  };
  const commentRoute = async (method: string, id: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!store.getState().review?.waiting) return void json(res, 409, NOT_WAITING);
    if (!human) return void json(res, 404, { error: "comments are not available" });
    const comments = humanStore(human.runDir);
    if (method === "PUT") return commentWrite(req, res, patchCommentSchema, (patch) => comments.edit(id, patch), 200);
    try {
      await comments.remove(id);
      json(res, 200, { ok: true });
    } catch (err) {
      if (!(err instanceof HumanReviewError)) throw err;
      json(res, err.kind === "unknown" ? 404 : 400, { error: err.message });
    }
  };

  const statusRoute = async (id: string, action: "resolve" | "reopen", req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!store.getState().review?.waiting) return void json(res, 409, NOT_WAITING);
    if (!human) return void json(res, 404, { error: "comments are not available" });
    const comments = humanStore(human.runDir);
    if (action === "resolve") {
      try {
        const resolved = await comments.resolve(id);
        await refreshBlocking();
        return void json(res, 200, resolved);
      } catch (err) {
        if (!(err instanceof HumanReviewError)) throw err;
        return void json(res, err.kind === "unknown" ? 404 : 400, { error: err.message });
      }
    }
    await commentWrite(
      req,
      res,
      reopenSchema,
      async (input) => {
        const reopened = await comments.reopen(id, input.followUp);
        await refreshBlocking();
        return reopened;
      },
      200,
    );
  };

  const retryRoute = (id: string, res: http.ServerResponse): void => {
    if (!graphModel({ layers: meta.layers, parents: meta.parents, state: store.getState(), mergeTarget: meta.mergeTarget }).nodes.has(id)) {
      return void json(res, 404, { error: `unknown node ${id}` });
    }
    const result = store.getState().retryable.includes(id) && retry ? retry.retryNode(id) : undefined;
    if (!result || !result.ok) return void json(res, 409, { error: `${id} is not failed` });
    json(res, 200, { ok: true });
  };

  const changesRoute = async (id: string, file: string | null, res: http.ServerResponse): Promise<void> => {
    const node = graphModel({ layers: meta.layers, parents: meta.parents, state: store.getState(), mergeTarget: meta.mergeTarget }).nodes.get(id);
    if (!node) return void json(res, 404, { error: `unknown node ${id}` });
    const files = node.view.changes?.files ?? [];
    if (file === null) return void json(res, 200, { files });
    // Only paths from the node's own change list reach the tracker.
    if (!files.some((f) => f.path === file)) return void json(res, 400, { error: "unknown file" });
    const diff = await changes?.fileDiff(id, file);
    if (!diff) return void json(res, 404, { error: `no diff for ${file}` });
    json(res, 200, diff);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host ?? "")) return void res.writeHead(421).end("Misdirected Request");
    const origin = req.headers.origin;
    if (req.method !== "GET" && req.method !== "HEAD" && origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) {
      return void res.writeHead(403).end("Forbidden");
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    if (req.method === "GET" && pathname.startsWith("/changes/")) {
      let id: string;
      try {
        id = decodeURIComponent(pathname.slice("/changes/".length));
      } catch {
        return void json(res, 404, { error: "unknown node" });
      }
      return changesRoute(id, url.searchParams.get("file"), res);
    }
    const action = req.method === "POST" ? /^\/review\/comments\/([^/]+)\/(resolve|reopen)$/.exec(pathname) : null;
    if (action) {
      let id: string;
      try {
        id = decodeURIComponent(action[1]!);
      } catch {
        return void json(res, 404, { error: "unknown comment" });
      }
      return statusRoute(id, action[2] as "resolve" | "reopen", req, res);
    }
    if ((req.method === "PUT" || req.method === "DELETE") && pathname.startsWith("/review/comments/")) {
      let id: string;
      try {
        id = decodeURIComponent(pathname.slice("/review/comments/".length));
      } catch {
        return void json(res, 404, { error: "unknown comment" });
      }
      return commentRoute(req.method, id, req, res);
    }
    if (req.method === "POST" && pathname.startsWith("/retry/")) {
      let id: string;
      try {
        id = decodeURIComponent(pathname.slice("/retry/".length));
      } catch {
        return void json(res, 404, { error: "unknown node" });
      }
      return retryRoute(id, res);
    }
    const route = routes[`${req.method} ${pathname}`];
    if (route) return void (await route(req, res));
    const known = pathname.startsWith("/retry/") || pathname.startsWith("/changes/") || pathname.startsWith("/review/comments/") || Object.keys(routes).some((k) => k.endsWith(` ${pathname}`));
    res.writeHead(known ? 405 : 404).end(known ? "Method Not Allowed" : "Not Found");
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
      for (const res of clients) res.end();
      server.closeAllConnections();
    });
  }

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    server,
    close: closeServer,
    setFatal: (f) => {
      fatal = f;
      store.addEvent(`error: ${f.message}`);
    },
  };
}
