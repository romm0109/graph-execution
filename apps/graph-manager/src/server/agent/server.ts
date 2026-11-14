// The workspace agent (docs/prd/hosted-sessions.md): every WorkspaceHost operation over HTTP JSON under /agent/v1/*,
// PTYs over a WebSocket and a run-page proxy, behind `Authorization: Bearer <GM_AGENT_TOKEN>`. It runs inside a
// session or run container and uses LocalWorkspaceHost, so it behaves exactly like local mode.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { z, ZodError } from "zod";
import { localWorkspacePath, LocalWorkspaceHost } from "../host/local.js";
import { HostError, type PtyProcess, type WorkspaceHost } from "../host/types.js";
import { commitProjectRun } from "../hosted-project-pr.js";
import { pipeToUpstream, upstreamPort } from "../proxy.js";
import { isRunId, livePage, runDirOf } from "../runs.js";
import { SCROLLBACK_MAX } from "../terminals.js";

export const AGENT_PREFIX = "/agent/v1";
const HEALTHZ = `${AGENT_PREFIX}/healthz`;
const VIEW = /^\/agent\/v1\/view\/([^/]+)\/([^/]+)(\/.*)?$/;

const ws = z.string().min(1);
const forge = z.enum(["github", "gitlab"]);
const repoRef = z.object({ forge, owner: z.string().min(1), name: z.string().min(1), baseUrl: z.string().optional() }).strict();
const gitAuth = z.object({ forge, token: z.string() }).strict();
const branch = z.union([z.object({ new: z.string() }).strict(), z.object({ existing: z.string() }).strict()]);
const prepareBody = z.union([
  z.object({ repo: repoRef, branch, cloneUrl: z.string().optional(), auth: gitAuth.optional() }).strict(),
  z
    .object({
      project: z
        .object({ id: z.string().min(1), name: z.string().min(1).optional(), repos: z.array(repoRef).min(1), cloneUrls: z.array(z.string()).optional() })
        .strict(),
      branch,
      cloneUrl: z.string().optional(),
      auth: gitAuth.optional(),
    })
    .strict(),
]);
const dim = z.number().int().min(1).max(1000);
const ptyBody = z.object({ workspaceId: ws, argv: z.array(z.string()), env: z.record(z.string(), z.string()), cols: dim, rows: dim }).strict();
const engineBody = z
  .object({ workspaceId: ws, args: z.array(z.string()), env: z.record(z.string(), z.string()), timeoutMs: z.number().int().positive(), resumeRunId: z.string().optional() })
  .strict();
const pathBody = z.object({ workspaceId: ws, path: z.string() }).strict();
const filesBody = z.object({ workspaceId: ws, path: z.string(), glob: z.string().optional() }).strict();
const wsBody = z.object({ workspaceId: ws }).strict();
const runBody = z.object({ workspaceId: ws, runId: z.string().min(1) }).strict();
const gitBody = z.object({ workspaceId: ws, args: z.array(z.string()), timeoutMs: z.number().int().positive().optional() }).strict();
const saveBody = z.object({ workspaceId: ws, branch: z.string().min(1), message: z.string(), auth: gitAuth.optional() }).strict();
const loginBody = z.object({ op: z.enum(["get", "put"]), providers: z.array(z.string()), files: z.record(z.string(), z.string()).optional() }).strict();
const pushBody = z.object({ workspaceId: ws, auth: gitAuth.optional() }).strict();
const writeBody = z.object({ workspaceId: ws, files: z.record(z.string(), z.string()) }).strict();
const projectPrBody = z.object({ projectId: z.string().regex(/^[a-z0-9-]+$/), runId: z.string().min(1), auth: gitAuth.optional() }).strict();

/** The most bytes of run folder files `POST /run-folder` answers; files after that are listed in `skipped`. */
export const RUN_FOLDER_CAP = 50 * 1024 * 1024;

/** The regular files under `root` (relative, `/`-separated), skipping `worktrees/`, `.git` folders and symlinks. */
async function walkFiles(root: string, rel = ""): Promise<string[]> {
  let items;
  try {
    items = await readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of items.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = rel ? `${rel}/${d.name}` : d.name;
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) {
      if (d.name === ".git" || (rel === "" && d.name === "worktrees")) continue;
      out.push(...(await walkFiles(root, child)));
    } else if (d.isFile()) out.push(child);
  }
  return out;
}

/** A relative path inside a workspace: no `..`, no absolute path, no NUL, nothing in `.git`. */
function safeRel(rel: string): boolean {
  if (rel === "" || rel.includes("\0") || path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) return false;
  const parts = rel.split(/[\\/]/);
  return !parts.includes("..") && !parts.includes(".git") && parts.every((x) => x !== "");
}

const clientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string() }),
  z.object({ type: z.literal("resize"), cols: z.number(), rows: z.number() }),
  z.object({ type: z.literal("kill"), signal: z.string().optional() }),
]);

interface Pty {
  proc: PtyProcess;
  buffered: string[];
  size: number;
  exitCode?: number;
  socket?: { readyState: number; OPEN: number; send(data: string): void; close(code?: number, reason?: string): void };
}

function decode(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}

export interface StartAgentOptions {
  port: number;
  /** Default 127.0.0.1; the CLI listens on 0.0.0.0 for the control plane on the container network. */
  host?: string;
  workspacesDir: string;
  token: string;
  graphExecutionBin?: string;
  loginHome?: string;
  /** The host the routes call; a LocalWorkspaceHost on workspacesDir by default. */
  hostImpl?: WorkspaceHost;
}

export async function startAgent(p: StartAgentOptions): Promise<{ url: string; close(): Promise<void> }> {
  const host: WorkspaceHost =
    p.hostImpl ?? new LocalWorkspaceHost({ workspacesDir: p.workspacesDir, graphExecutionBin: p.graphExecutionBin ?? "graph-execution", loginHome: p.loginHome });
  const ptys = new Map<string, Pty>();
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
  await app.register(websocket);

  // Constant time: both sides are hashed to the same length first.
  const want = createHash("sha256").update(`Bearer ${p.token}`).digest();
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === HEALTHZ) return;
    const got = createHash("sha256").update(String(req.headers.authorization ?? "")).digest();
    if (!timingSafeEqual(got, want)) return reply.code(401).send({ error: "unauthorized" });
  });

  // The run-page proxy: an onRequest hook after the auth hook, before body parsing, so bodies stream.
  app.addHook("onRequest", async (req, reply) => {
    const q = req.url.indexOf("?");
    const pathname = q === -1 ? req.url : req.url.slice(0, q);
    const search = q === -1 ? "" : req.url.slice(q);
    const m = VIEW.exec(pathname);
    if (!m) return;
    const [, wsPart = "", runPart = "", rest] = m;
    if (rest === undefined) return reply.redirect(`${pathname}/${search}`, 302);
    const wsId = decode(wsPart);
    const runId = decode(runPart);
    if (wsId === undefined || runId === undefined || !isRunId(runId)) return reply.code(400).send({ error: "invalid run id" });
    const wsPath = localWorkspacePath(p.workspacesDir, wsId);
    if (wsPath === undefined) return reply.code(404).send({ error: "unknown workspace" });
    const dir = runDirOf({ path: wsPath }, runId);
    if (!existsSync(dir)) return reply.code(404).send({ error: "unknown run" });
    const web = await livePage(dir);
    const port = web ? upstreamPort(web.url) : undefined;
    if (port === undefined) return reply.code(404).send({ error: "the run's page is not running" });
    pipeToUpstream(req, reply, { host: "127.0.0.1", port, hostHeader: `127.0.0.1:${port}`, dropHeaders: ["authorization"] }, rest + search);
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return reply.code(400).send({ error: `${where}${issue?.message ?? "invalid request"}` });
    }
    if (err instanceof HostError) return reply.code(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) return reply.code(status).send({ error: (err as Error).message });
    console.error(err);
    return reply.code(500).send({ error: "internal error" });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not found" }));

  const R = AGENT_PREFIX;
  app.get(HEALTHZ, async () => ({ ok: true }));

  app.post(`${R}/prepare`, async (req) => host.prepare(prepareBody.parse(req.body)));

  app.post(`${R}/pty`, async (req) => {
    const body = ptyBody.parse(req.body);
    const proc = await host.spawnPty(body);
    const id = randomBytes(16).toString("hex");
    const entry: Pty = { proc, buffered: [], size: 0 };
    ptys.set(id, entry);
    proc.onData((data) => {
      const s = entry.socket;
      if (s) {
        if (s.readyState === s.OPEN) s.send(JSON.stringify({ type: "data", data }));
        return;
      }
      entry.buffered.push(data);
      entry.size += data.length;
      while (entry.size > SCROLLBACK_MAX && entry.buffered.length > 1) entry.size -= entry.buffered.shift()!.length;
    });
    proc.onExit(({ exitCode }) => {
      entry.exitCode = exitCode;
      const s = entry.socket;
      if (!s) return;
      if (s.readyState === s.OPEN) s.send(JSON.stringify({ type: "exit", code: exitCode }));
      s.close(1000, "exited");
      ptys.delete(id);
    });
    return { id, pid: proc.pid };
  });

  app.get<{ Params: { id: string } }>(`${R}/pty/:id`, { websocket: true }, (socket, req) => {
    const id = req.params.id;
    const entry = ptys.get(id);
    if (!entry) {
      socket.close(4404, "pty not found");
      return;
    }
    if (entry.socket) {
      socket.close(4409, "pty already attached");
      return;
    }
    entry.socket = socket;
    for (const data of entry.buffered) socket.send(JSON.stringify({ type: "data", data }));
    entry.buffered = [];
    entry.size = 0;
    if (entry.exitCode !== undefined) {
      socket.send(JSON.stringify({ type: "exit", code: entry.exitCode }));
      socket.close(1000, "exited");
      ptys.delete(id);
      return;
    }
    socket.on("message", (raw: Buffer | string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const msg = clientMessage.safeParse(parsed);
      if (!msg.success) return;
      try {
        if (msg.data.type === "input") entry.proc.write(msg.data.data);
        else if (msg.data.type === "resize") entry.proc.resize(msg.data.cols, msg.data.rows);
        else entry.proc.kill(msg.data.signal);
      } catch {
        // the process is gone
      }
    });
    socket.on("close", () => {
      if (ptys.get(id) !== entry) return;
      ptys.delete(id);
      if (entry.exitCode === undefined) {
        try {
          entry.proc.kill();
        } catch {
          // already gone
        }
      }
    });
  });

  app.post(`${R}/engine/start`, async (req) => host.startEngine(engineBody.parse(req.body)));

  app.post(`${R}/file`, async (req, reply) => {
    const b = pathBody.parse(req.body);
    const text = await host.readFile(b.workspaceId, b.path);
    return text === undefined ? reply.code(404).send({ error: "not found" }) : { text };
  });

  app.post(`${R}/stat`, async (req, reply) => {
    const b = pathBody.parse(req.body);
    const st = await host.stat(b.workspaceId, b.path);
    return st === undefined ? reply.code(404).send({ error: "not found" }) : st;
  });

  app.post(`${R}/files`, async (req) => {
    const b = filesBody.parse(req.body);
    return { files: await host.listFiles(b.workspaceId, b.path, b.glob !== undefined ? { glob: b.glob } : {}) };
  });

  app.post(`${R}/runs`, async (req) => ({ runs: await host.listRuns(wsBody.parse(req.body).workspaceId) }));

  app.post(`${R}/run`, async (req, reply) => {
    const b = runBody.parse(req.body);
    const detail = await host.runDetail(b.workspaceId, b.runId);
    return detail === undefined ? reply.code(404).send({ error: "not found" }) : detail;
  });

  app.post(`${R}/git`, async (req) => {
    const b = gitBody.parse(req.body);
    return host.git(b.workspaceId, b.args, b.timeoutMs !== undefined ? { timeoutMs: b.timeoutMs } : {});
  });

  app.get(`${R}/activity`, async () => host.activity());

  app.post(`${R}/changes`, async (req) => ({ changes: await host.changes(wsBody.parse(req.body).workspaceId) }));

  // `filter` never crosses the wire: the inner host always skips secrets (isSecretPath).
  app.post(`${R}/save`, async (req) => host.save(saveBody.parse(req.body)));

  app.post(`${R}/discard`, async (req, reply) => {
    await host.discard(wsBody.parse(req.body).workspaceId);
    return reply.code(204).send();
  });

  app.post(`${R}/login-files`, async (req) => {
    const b = loginBody.parse(req.body);
    return { files: await host.loginFiles(b.op, b.providers, b.files) };
  });

  app.post(`${R}/push-branch`, async (req) => {
    const b = pushBody.parse(req.body);
    return host.pushBranch(b.workspaceId, b.auth ? { auth: b.auth } : {});
  });

  // Hosted runs: the control plane writes the run's inputs it cannot clone (a project's specs and tasks, the owner's
  // reviewers file) into the run container. Answers each file's absolute path.
  app.post(`${R}/write-files`, async (req) => {
    const b = writeBody.parse(req.body);
    const root = localWorkspacePath(p.workspacesDir, b.workspaceId);
    if (root === undefined) throw new HostError(404, "unknown workspace");
    const paths: Record<string, string> = {};
    for (const [rel, text] of Object.entries(b.files)) {
      if (!safeRel(rel)) throw new HostError(400, `invalid path: ${rel}`);
      const full = path.join(root, ...rel.split("/"));
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, text, { mode: 0o600 });
      paths[rel] = full;
    }
    return { paths };
  });

  // Hosted runs: the run folder's files (base64), for the control plane's run archive.
  app.post(`${R}/run-folder`, async (req, reply) => {
    const b = runBody.parse(req.body);
    if (!isRunId(b.runId)) return reply.code(400).send({ error: "invalid run id" });
    const root = localWorkspacePath(p.workspacesDir, b.workspaceId);
    if (root === undefined) return reply.code(404).send({ error: "unknown workspace" });
    const dir = runDirOf({ path: root }, b.runId);
    if (!existsSync(dir)) return reply.code(404).send({ error: "unknown run" });
    const files: { path: string; content: string }[] = [];
    const skipped: string[] = [];
    let total = 0;
    for (const rel of await walkFiles(dir)) {
      const full = path.join(dir, ...rel.split("/"));
      try {
        const size = (await stat(full)).size;
        if (total + size > RUN_FOLDER_CAP) {
          skipped.push(rel);
          continue;
        }
        const buf = await readFile(full);
        total += buf.length;
        files.push({ path: rel, content: buf.toString("base64") });
      } catch {
        // gone while walking
      }
    }
    return { files, skipped };
  });

  // Create PR of a hosted project run, the git half: commit and push `gm/<runId>` in every changed repository.
  app.post(`${R}/project-pr`, async (req) => {
    const b = projectPrBody.parse(req.body);
    return { repos: await commitProjectRun({ workspacesDir: p.workspacesDir, projectId: b.projectId, runId: b.runId, ...(b.auth ? { auth: b.auth } : {}) }) };
  });

  app.addHook("onClose", async () => {
    for (const entry of ptys.values()) {
      try {
        entry.proc.kill();
      } catch {
        // already gone
      }
      entry.socket?.close(1001, "agent stopping");
    }
    ptys.clear();
  });

  const listenHost = p.host ?? "127.0.0.1";
  await app.listen({ port: p.port, host: listenHost });
  const port = (app.server.address() as AddressInfo).port;
  const urlHost = listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost === "::" ? "[::1]" : listenHost.includes(":") ? `[${listenHost}]` : listenHost;
  return { url: `http://${urlHost}:${port}`, close: () => app.close() };
}
