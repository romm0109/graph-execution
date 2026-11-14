import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { REVIEWERS_ENV, RUN_ID_ENV } from "graph-execution/api";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { SessionRecord, UserStore } from "../store.js";
import { ExtraArgsError, projectStartArgs, runOptionsSchema, startArgs, type RunOptionsBody } from "../runoptions.js";
import { userReviewersFile } from "../reviewers.js";
import { attachPr, attachPrs, isRunId, newestFirst, viewUrlOf, type RunSummary } from "../runs.js";
import { homeAsWorkspace, projectHome, resolveRunHome, sandboxRepos, type RunHome } from "../runhome.js";
import { lastLines, START_TIMEOUT_MS } from "../engine.js";
import { clientFor, connFor } from "../forges.js";
import { HostError, type GitAuth, type WorkspaceHost } from "../host/types.js";
import type { User } from "../identity.js";
import { SandboxError } from "../sandbox-run.js";
import { agentKeyEnv } from "../sessions/logins.js";
import { listWorkspaces, type Workspace } from "../workspaces.js";

export const PROVIDERS = ["claude", "codex", "opencode", "qwen", "fake"] as const;

const startBody = z.object({
  tasksDir: z.string().min(1),
  spec: z.string().min(1),
  provider: z.enum(PROVIDERS),
  concurrency: z.number().int().min(1).max(64).optional(),
  options: runOptionsSchema.optional(),
  sandbox: z.boolean().optional(),
});

/** A project start: no paths (the project folder's `specs/` and `tasks/` are the input). */
const projectStartBody = z.object({
  provider: z.enum(PROVIDERS),
  concurrency: z.number().int().min(1).max(64).optional(),
  options: runOptionsSchema.optional(),
  sandbox: z.boolean().optional(),
});

export { engineCommand, INTERNAL_ENV, lastLines, START_TIMEOUT_MS } from "../engine.js";

const pad = (n: number): string => String(n).padStart(2, "0");

/** `gm-<yyyymmdd-hhmmss>-<4 hex>` in local time. */
export function newRunId(now = new Date()): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `gm-${date}-${time}-${randomBytes(2).toString("hex")}`;
}

/** `rel` resolved inside the workspace (symlinks followed), or undefined when it escapes it or does not exist. */
export function insideWorkspace(ws: Workspace, rel: string): string | undefined {
  if (path.isAbsolute(rel) || rel.includes("\0")) return undefined;
  const full = path.resolve(ws.path, rel);
  if (!existsSync(full)) return undefined;
  const real = realpathSync(full);
  const root = realpathSync(ws.path);
  return real === root || real.startsWith(root + path.sep) ? full : undefined;
}


/** Saves the last value of "Run in sandbox" for the workspace. */
async function rememberSandbox(us: UserStore, id: string, on: boolean): Promise<void> {
  await us.update((d) => {
    d.workspaceSettings[id] = { ...d.workspaceSettings[id], sandbox: on };
  });
}

/** The workspace or project (`project~<id>`) with this id. */
function homeOr404(ctx: AppContext, us: UserStore, id: string): RunHome | undefined {
  return resolveRunHome(ctx.config.workspacesDir, us, id);
}

/** The variables of a new run's engine start, added to the host's engine base env. */
function engineEnv(runId: string, keys: Record<string, string>, reviewersFile: string): Record<string, string> {
  // The requesting user's saved agent keys (Settings → Agents) and their own reviewers file.
  return { ...keys, [RUN_ID_ENV]: runId, ...(existsSync(reviewersFile) ? { [REVIEWERS_ENV]: reviewersFile } : {}) };
}

/** A path inside the home exists (symlinks followed and inside it). */
async function existsIn(host: WorkspaceHost, id: string, rel: string): Promise<boolean> {
  const st = await host.stat(id, rel);
  return st !== undefined && !(st.symlink && st.kind === "other");
}

/**
 * The user's session on `workspaceId` when its host is remote (a Docker or hosted session): its runs are hosted runs.
 * Undefined for a local host; 404 when the only session on it is ending.
 */
async function remoteSessionOf(ctx: AppContext, us: UserStore, user: User, workspaceId: string): Promise<{ session: SessionRecord; host: WorkspaceHost } | undefined> {
  const all = Object.values(us.get().sessions).filter((s) => s.workspaceId === workspaceId && s.state !== "starting");
  if (all.length === 0) return undefined;
  const host = await ctx.hostFor(workspaceId, user);
  if (host.kind !== "remote") return undefined;
  const session = all.find((s) => s.state !== "ending");
  if (!session) throw new HostError(404, "unknown workspace");
  return { session: structuredClone(session), host };
}

/**
 * A run of a remote session (docs/prd/hosted-sessions.md, "Hosted runs"): in its own run container, from the session
 * branch's last pushed commit. `sandbox` is ignored: every hosted run is sandboxed.
 */
async function startHosted(
  ctx: AppContext,
  us: UserStore,
  user: User,
  remote: { session: SessionRecord; host: WorkspaceHost },
  rawBody: unknown,
  keys: Record<string, string>,
  log: { warn(obj: unknown, msg: string): void },
): Promise<{ status: number; body: unknown }> {
  // The slot is held from here until the run's record is stored (F8: concurrent starts cannot both pass the cap).
  const release = ctx.hostedRuns.reserve(user, us, ctx.config.maxRunContainers);
  try {
    return await startHostedReserved(ctx, us, user, remote, rawBody, keys, log, release);
  } finally {
    release();
  }
}

async function startHostedReserved(
  ctx: AppContext,
  us: UserStore,
  user: User,
  remote: { session: SessionRecord; host: WorkspaceHost },
  rawBody: unknown,
  keys: Record<string, string>,
  log: { warn(obj: unknown, msg: string): void },
  reserved: () => void,
): Promise<{ status: number; body: unknown }> {
  const { session, host } = remote;
  const id = session.workspaceId;
  const project = session.projectId !== undefined;
  let args: string[];
  let defaults: { provider: string; tasksDir: string; spec: string; options: RunOptionsBody };
  try {
    if (project) {
      const body = projectStartBody.parse(rawBody ?? {});
      const options: RunOptionsBody = { ...(body.concurrency !== undefined ? { concurrency: body.concurrency } : {}), ...body.options };
      args = projectStartArgs({ provider: body.provider, options });
      defaults = { provider: body.provider, tasksDir: "", spec: "", options };
    } else {
      const body = startBody.parse(rawBody ?? {});
      const options: RunOptionsBody = { ...(body.concurrency !== undefined ? { concurrency: body.concurrency } : {}), ...body.options };
      if (!(await existsIn(host, id, body.tasksDir))) return { status: 400, body: { error: `tasksDir: ${body.tasksDir} is not a folder inside the workspace` } };
      if (!(await existsIn(host, id, body.spec))) return { status: 400, body: { error: `spec: ${body.spec} is not a file inside the workspace` } };
      args = startArgs({ tasksDir: body.tasksDir, spec: body.spec, provider: body.provider, options });
      defaults = { provider: body.provider, tasksDir: body.tasksDir, spec: body.spec, options };
    }
  } catch (err) {
    if (err instanceof ExtraArgsError) return { status: 400, body: { error: err.message } };
    throw err;
  }
  const forge = session.repo.forge;
  const conn = connFor(ctx, us, forge);
  const auth: GitAuth | undefined = conn ? { forge, token: conn.token } : undefined;
  const pushed = await host.pushBranch(id, auth ? { auth } : {});
  if (!pushed.ok) throw new HostError(409, `Could not push ${session.branch} before the run: ${pushed.error ?? "push failed"}`);
  const repos = session.repos ?? [session.repo];
  const cloneUrls = await Promise.all(
    repos.map(async (r) => {
      if (!connFor(ctx, us, r.forge)) return undefined;
      try {
        return (await clientFor(ctx, us, r.forge).getRepo(`${r.owner}/${r.name}`)).cloneUrl;
      } catch {
        return undefined;
      }
    }),
  );

  const runId = project ? `suite-${newRunId()}` : newRunId();
  const res = await ctx.hostedRuns.startRun({
    user,
    us,
    session,
    runId,
    args,
    env: { ...keys, [RUN_ID_ENV]: runId },
    timeoutMs: START_TIMEOUT_MS,
    ...(auth ? { auth } : {}),
    cloneUrls,
    ...(project ? { sessionHost: host } : {}),
    reserved,
  });
  if (!res.ok) return { status: 400, body: { error: res.error, exitCode: res.exitCode, output: res.output } };
  await us
    .update((d) => {
      d.runDefaults[id] = defaults;
    })
    .catch((err: unknown) => log.warn({ err }, "could not save the run defaults"));
  return { status: 201, body: { runId, viewUrl: viewUrlOf(id, runId) } };
}

export async function runsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Querystring: { workspace?: string } }>("/api/runs", async (req) => {
    await ctx.hostedRuns.reattach(req.user);
    const us = await ctx.store.forUser(req.user);
    const filter = req.query.workspace;
    const prs = us.get().prs;
    const runsOf = async (id: string): Promise<RunSummary[]> => (await ctx.hostFor(id, req.user)).listRuns(id);
    // Archived runs whose folder is gone (their workspace or session ended) come after the local ones are known.
    const withArchived = async (own: RunSummary[]): Promise<RunSummary[]> => {
      // The user's live hosted runs, from their run containers.
      const hosted = attachPrs(await ctx.hostedRuns.summaries(req.user, filter), prs);
      const ownKeys = new Set(own.map((r) => `${r.workspaceId}/${r.id}`));
      const local = [...own, ...hosted.filter((r) => !ownKeys.has(`${r.workspaceId}/${r.id}`))];
      const archived = await ctx.runArchive.list(req.user, filter ? { workspaceId: filter } : undefined);
      const here = new Set(local.map((r) => `${r.workspaceId}/${r.id}`));
      return [...local, ...archived.filter((r) => !here.has(`${r.workspaceId}/${r.id}`))].sort(newestFirst);
    };
    if (filter) {
      if (!(await ctx.sessions.ownsWorkspace(req.user, filter))) return { runs: [] };
      const home = homeOr404(ctx, us, filter);
      return { runs: await withArchived(home ? attachPrs(await runsOf(home.id), prs) : []) };
    }
    const ids: string[] = [];
    for (const ws of await listWorkspaces(ctx.config.workspacesDir)) if (await ctx.sessions.ownsWorkspace(req.user, ws.id)) ids.push(ws.id);
    for (const [id, rec] of Object.entries(us.get().projects)) {
      const home = projectHome(ctx.config.workspacesDir, id, rec);
      if (home) ids.push(home.id);
    }
    const all = await Promise.all(ids.map(runsOf));
    return { runs: await withArchived(attachPrs(all.flat(), prs)) };
  });

  app.get<{ Params: { ws: string; runId: string } }>("/api/runs/:ws/:runId", async (req, reply) => {
    if (!isRunId(req.params.runId)) return reply.code(400).send({ error: "invalid run id" });
    const us = await ctx.store.forUser(req.user);
    // A live hosted run: from its run container.
    const runHost = ctx.hostedRuns.hostOf(req.user, req.params.ws, req.params.runId);
    if (runHost) {
      const detail = await runHost.runDetail(req.params.ws, req.params.runId);
      if (detail) {
        attachPr(detail.summary, us.get().prs);
        return detail;
      }
    }
    const home = homeOr404(ctx, us, req.params.ws);
    if (home) {
      const host = await ctx.hostFor(home.id, req.user);
      const detail = await host.runDetail(home.id, req.params.runId);
      if (detail) {
        attachPr(detail.summary, us.get().prs);
        return detail;
      }
    }
    // Gone from disk: the run archive has it when it was archived (always the caller's own runs).
    const archived = await ctx.runArchive.get(req.user, req.params.ws, req.params.runId);
    if (archived) return archived;
    return reply.code(404).send({ error: home ? "unknown run" : "unknown workspace" });
  });

  app.get<{ Params: { ws: string; runId: string }; Querystring: { path?: string } }>("/api/runs/:ws/:runId/archive/file", async (req, reply) => {
    if (!isRunId(req.params.runId)) return reply.code(400).send({ error: "invalid run id" });
    const rel = req.query.path;
    if (typeof rel !== "string" || rel.includes("\0") || path.isAbsolute(rel) || path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel) || rel.split(/[\\/]/).includes("..") || rel.trim() === "") {
      return reply.code(400).send({ error: "invalid path" });
    }
    const stream = await ctx.runArchive.openFile(req.user, req.params.ws, req.params.runId, rel);
    if (!stream) return reply.code(404).send({ error: "file not in the archive" });
    return reply
      .header("cache-control", "no-store")
      .type(rel.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8")
      .send(stream);
  });

  app.post<{ Params: { ws: string } }>("/api/runs/:ws", async (req, reply) => {
    await ctx.hostedRuns.reattach(req.user);
    const us = await ctx.store.forUser(req.user);
    // A remote session (Docker or hosted): every run gets its own run container; never a local engine or sandbox.
    const remote = await remoteSessionOf(ctx, us, req.user, req.params.ws);
    if (remote) {
      const res = await startHosted(ctx, us, req.user, remote, req.body, await agentKeyEnv(ctx.store, req.user), req.log);
      return reply.code(res.status).send(res.body);
    }
    const home = homeOr404(ctx, us, req.params.ws);
    if (!home) return reply.code(404).send({ error: "unknown workspace" });
    const keys = await agentKeyEnv(ctx.store, req.user);
    const reviewersFile = await userReviewersFile(ctx.config.dataDir, req.user, us);

    // A project (MR-08): a multi-repo suite, started in the project folder.
    if (home.kind === "project") {
      const body = projectStartBody.parse(req.body ?? {});
      const options: RunOptionsBody = { ...(body.concurrency !== undefined ? { concurrency: body.concurrency } : {}), ...body.options };
      let args: string[];
      try {
        args = projectStartArgs({ provider: body.provider, options });
      } catch (err) {
        if (err instanceof ExtraArgsError) return reply.code(400).send({ error: err.message });
        throw err;
      }
      const wanted = `suite-${newRunId()}`;
      const saveProjectDefaults = (): Promise<void> =>
        us
          .update((d) => {
            d.runDefaults[home.id] = { provider: body.provider, tasksDir: "", spec: "", options };
          })
          .catch((err: unknown) => req.log.warn({ err }, "could not save the run defaults"));
      // Sandboxed: the suite gets its own container with the project folder and every repo mounted; the engine
      // takes the suite id from GRAPH_EXECUTION_RUN_ID, so the container, record and ready file know it up front.
      if (body.sandbox === true) {
        if (!ctx.sandboxes) return reply.code(400).send({ error: "sandboxes are not set up" });
        const { repos, missing } = await sandboxRepos(ctx.config.workspacesDir, home);
        if (missing !== undefined) return reply.code(409).send({ error: `repo ${missing} has no workspace` });
        try {
          await ctx.sandboxes.start({
            ws: homeAsWorkspace(home),
            cwd: home.path,
            args: args.filter((a) => a !== "--web"),
            runId: wanted,
            providers: [body.provider],
            repos,
            extraEnv: keys,
            store: us,
            reviewersFile,
          });
        } catch (err) {
          if (err instanceof SandboxError) {
            return reply.code(err.status).send({ error: err.message, ...(err.output ? { output: lastLines(err.output, 20) } : {}) });
          }
          throw err;
        }
        await rememberSandbox(us, home.id, true);
        await saveProjectDefaults();
        return reply.code(201).send({ runId: wanted, viewUrl: viewUrlOf(home.id, wanted) });
      }
      const host = await ctx.hostFor(home.id, req.user);
      const res = await host.startEngine({ workspaceId: home.id, args, env: engineEnv(wanted, keys, reviewersFile), timeoutMs: START_TIMEOUT_MS });
      if (!res.ok) return reply.code(400).send({ error: res.error, exitCode: res.exitCode, output: res.output });
      const printed = /\b(?:Started suite|Suite) (suite-\S+?)(?: in the background)?(?::| started:)/.exec(res.stdout)?.[1];
      const id = printed && isRunId(printed) ? printed : isRunId(wanted) ? wanted : undefined;
      if (id === undefined) return reply.code(400).send({ error: "graph-execution did not print the id of the suite", output: lastLines(res.stdout, 20) });
      await rememberSandbox(us, home.id, false);
      await saveProjectDefaults();
      return reply.code(201).send({ runId: id, viewUrl: viewUrlOf(home.id, id) });
    }

    const ws = home.workspace;
    const body = startBody.parse(req.body ?? {});
    const host = await ctx.hostFor(home.id, req.user);
    if (!(await existsIn(host, home.id, body.tasksDir))) return reply.code(400).send({ error: `tasksDir: ${body.tasksDir} is not a folder inside the workspace` });
    if (!(await existsIn(host, home.id, body.spec))) return reply.code(400).send({ error: `spec: ${body.spec} is not a file inside the workspace` });

    const runId = newRunId();
    // The top-level `concurrency` is kept for older clients; `options.concurrency` wins when both are given.
    const options: RunOptionsBody = { ...(body.concurrency !== undefined ? { concurrency: body.concurrency } : {}), ...body.options };
    let args: string[];
    try {
      args = startArgs({ tasksDir: body.tasksDir, spec: body.spec, provider: body.provider, options });
    } catch (err) {
      if (err instanceof ExtraArgsError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    const saveDefaults = (): Promise<void> =>
      us
        .update((d) => {
          d.runDefaults[ws.id] = { provider: body.provider, tasksDir: body.tasksDir, spec: body.spec, options };
        })
        .catch((err: unknown) => req.log.warn({ err }, "could not save the run defaults"));

    // Sandboxed (KAN-88): the run gets its own container; never `--web` (the container adds `--web-serve`).
    if (body.sandbox === true) {
      if (!ctx.sandboxes) return reply.code(400).send({ error: "sandboxes are not set up" });
      const sbArgs = args.filter((a) => a !== "--web");
      try {
        await ctx.sandboxes.start({ ws, cwd: ws.path, args: sbArgs, runId, providers: [body.provider], extraEnv: keys, store: us, reviewersFile });
      } catch (err) {
        if (err instanceof SandboxError) {
          return reply.code(err.status).send({ error: err.message, ...(err.output ? { output: lastLines(err.output, 20) } : {}) });
        }
        throw err;
      }
      await rememberSandbox(us, ws.id, true);
      await saveDefaults();
      return reply.code(201).send({ runId, viewUrl: viewUrlOf(ws.id, runId) });
    }

    const res = await host.startEngine({ workspaceId: home.id, args, env: engineEnv(runId, keys, reviewersFile), timeoutMs: START_TIMEOUT_MS });
    if (!res.ok) return reply.code(400).send({ error: res.error, exitCode: res.exitCode, output: res.output });
    // The run id we set reaches the detached run (GRAPH_EXECUTION_* variables pass through); trust stdout if it differs.
    const printed = /\b(?:Started run|Run) (\S+)(?: in the background)?(?::| started:)/.exec(res.stdout)?.[1];
    const id = printed && isRunId(printed) ? printed : runId;
    await rememberSandbox(us, ws.id, false);
    await saveDefaults();
    return reply.code(201).send({ runId: id, viewUrl: viewUrlOf(ws.id, id) });
  });

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/run-defaults", async (req, reply) => {
    const us = await ctx.store.forUser(req.user);
    const home = homeOr404(ctx, us, req.params.id);
    if (!home) return reply.code(404).send({ error: "unknown workspace" });
    return us.get().runDefaults[home.id] ?? {};
  });

  // Settings → Repositories' "Forget run defaults". Idempotent: an id without saved defaults answers 204 too.
  app.delete<{ Params: { id: string } }>("/api/workspaces/:id/run-defaults", async (req, reply) => {
    const us = await ctx.store.forUser(req.user);
    if (Object.hasOwn(us.get().runDefaults, req.params.id)) {
      await us.update((d) => {
        delete d.runDefaults[req.params.id];
      });
    }
    return reply.code(204).send();
  });
}
