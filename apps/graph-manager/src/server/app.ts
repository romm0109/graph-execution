import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AgentRequests } from "./agent-requests.js";
import { writeClaudeMcpConfig } from "./agents.js";
import { countUsers, ensureAdmin, listUsers, toUser } from "./accounts.js";
import { authRoutes } from "./auth.js";
import type { Config } from "./config.js";
import { connFor, ForgeError, forgeClient } from "./forges.js";
import { proxyRoutes } from "./proxy.js";
import { accountRoutes } from "./routes/accounts.js";
import { agentRequestRoutes } from "./routes/agent-requests.js";
import { prRoutes } from "./routes/pr.js";
import { projectRoutes } from "./routes/projects.js";
import { reviewerRoutes } from "./routes/reviewers.js";
import { resumeRoutes } from "./routes/resume.js";
import { forgeRoutes } from "./routes/forges.js";
import { gatewayRoutes } from "./routes/gateway.js";
import { uiRoutes } from "./routes/ui.js";
import { healthRoutes } from "./routes/health.js";
import { inspectRoutes } from "./routes/inspect.js";
import { internalRoutes } from "./routes/internal.js";
import { runsRoutes } from "./routes/runs.js";
import { sandboxRoutes } from "./routes/sandbox.js";
import { specRoutes } from "./routes/specs.js";
import { sessionRoutes } from "./routes/sessions.js";
import { noticeRoutes } from "./routes/notices.js";
import { agentKeyRoutes } from "./routes/agent-keys.js";
import { openTerminal, terminalRoutes } from "./routes/terminals.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { reviewersFilePath, writeReviewersFile } from "./reviewers.js";
import { clearSandboxLookup, setSandboxLookup } from "./runs.js";
import { Sandboxes } from "./sandbox.js";
import { openDb, type Db } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { HostError, type GitAuth, type RepoRef, type WorkspaceHost } from "./host/types.js";
import { DockerProvisioner } from "./sessions/docker-provisioner.js";
import { LocalProvisioner, type SessionProvisioner } from "./sessions/provisioner.js";
import { RuntimeProvisioner } from "./sessions/runtime.js";
import { SessionManager } from "./sessions/sessions.js";
import { IdleMonitor } from "./sessions/idle.js";
import { registerLoginHooks } from "./sessions/logins.js";
import { LocalWorkspaceHost } from "./host/local.js";
import { ADMIN_USER, type User } from "./identity.js";
import { SqlStore, type Store } from "./store.js";
import { TerminalManager, writeGraphExecutionShim, writeMcpShim } from "./terminals.js";
import { TOOLS } from "./tools/index.js";
import type { GmTool } from "./tools/types.js";
import { UserLifecycle } from "./user-lifecycle.js";
import { ViewCache } from "./viewcache.js";
import { openBlobStore, type BlobStore } from "./blobs.js";
import { RunArchiver, SqlRunArchive, type RunArchive } from "./runarchive.js";
import { HostedRuns } from "./hosted-runs.js";

/** What every feature route module gets. Later features may add optional fields. */
export interface AppContext {
  config: Config;
  /** The instance settings and each user's store: `await ctx.store.forUser(req.user)`. */
  store: Store;
  /** The database under the store (SQLite or Postgres); features with their own tables use it. */
  db: Db;
  terminals: TerminalManager;
  /** Snapshots live run pages into `<dataDir>/views/`. */
  viewCache?: ViewCache;
  /** Docker sandboxes of runs (KAN-88). */
  sandboxes?: Sandboxes;
  /** The terminals' token and URL for /api/internal/* (KAN-88). */
  internal?: { token: string; url: string };
  /** Tools for agents in terminals (src/server/tools). */
  tools: GmTool[];
  /** UI requests from agents' tools for the browser (docs/prd/agent-tools.md). */
  agentRequests: AgentRequests;
  /** The host of the workspaces folder on this server. Only app.ts builds it; routes use `hostFor`. */
  localHost: LocalWorkspaceHost;
  /** The ONLY way routes get a host: the host of the user's session on the workspace; 404 for a workspace not theirs. */
  hostFor(workspaceId: string, user: User): Promise<WorkspaceHost>;
  /** Where sessions run (local: the one shared local host). */
  provisioner: SessionProvisioner;
  /** Repo sessions (sessions/sessions.ts). */
  sessions: SessionManager;
  /** Ends idle sessions (sessions/idle.ts); only with `GM_SESSION_IDLE_MINUTES`. */
  idle?: IdleMonitor;
  /** What features do when the gateway disables or deletes a user (routes/gateway.ts). */
  userLifecycle: UserLifecycle;
  /** Rows and folder blobs of runs, kept after their workspace or session is gone. */
  runArchive: RunArchive;
  /** Where blobs (run archives) go: `<dataDir>/blobs/` or S3 (`GM_BLOB_URL`). */
  blobs: BlobStore;
  /** Runs of remote sessions, each in its own run container (hosted-runs.ts). */
  hostedRuns: HostedRuns;
}

export interface BuildAppOptions {
  store?: Store;
  /** The database (tests pass an in-memory SQLite); opened from the config otherwise, and then closed with the app. */
  db?: Db;
  /** Fastify's logger; off unless set. */
  logger?: boolean;
  /** The built UI to serve; defaults to `dist/web` next to `dist/server`. */
  webDir?: string;
  /** `false` turns off the background view cache (tests); on by default. */
  viewCache?: false;
  runArchive?: RunArchive;
  blobs?: BlobStore;
  /** `false` turns off the background run archiver (tests); on by default. */
  archiver?: false;
  /** Starts the sandbox service (Docker ping, network) once listening; main.ts sets it, tests do not. */
  startSandboxes?: boolean;
  /** Fixed internal token (tests); random otherwise. */
  internalToken?: string;
  /** Replaces the registry's tools (tests). */
  tools?: GmTool[];
  /** Replaces the LocalProvisioner (tests, hosted deployments). */
  provisioner?: SessionProvisioner;
  /** How often the hosted-run monitor polls (tests); default 5000 ms. */
  hostedRunsIntervalMs?: number;
  /** Session timing and the live-run probe (tests). */
  sessions?: { pollMs?: number; liveRuns?: (host: WorkspaceHost, workspaceId: string) => Promise<number> };
  /** Called right after the context is built (tests reach `ctx.sessions` through it). */
  onContext?: (ctx: AppContext) => void;
}

/** Whether `admin`'s password still is the install's password, and how many accounts there are (main.ts prints it). */
export interface AdminStatus {
  adminMatches: boolean;
  users: number;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Set by buildApp in `users` auth mode; undefined otherwise. */
    adminStatus: AdminStatus | undefined;
    /** The app's feature context (tests register user hooks on `ctx.userLifecycle`). */
    ctx: AppContext;
  }
}

/** The host terminals reach this server at: loopback unless it listens on one specific address. */
export function loopbackHost(host: string): string {
  if (host === "" || host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host.includes(":") ? `[${host}]` : host;
}

const RUN_VIEW = /^\/runs\/[^/]+\/[^/]+\/view(\/|$)/;

export async function buildApp(config: Config, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const db = opts.db ?? (await openDb(config));
  let store: Store;
  try {
    store = opts.store ?? (await SqlStore.open(db, { dataDir: config.dataDir }));
  } catch (err) {
    if (!opts.db) await db.close();
    throw err;
  }
  let adminStatus: AdminStatus | undefined;
  try {
    // A store passed in by a test may sit on another db: the accounts' tables must exist on this one.
    await migrate(db);
    // An existing install becomes the account `admin` with the password it has today.
    if (config.auth !== "gateway") adminStatus = await ensureAdmin(db, config.password, config.passwordSource);
  } catch (err) {
    if (!opts.db) await db.close();
    throw err;
  }
  let blobs: BlobStore;
  try {
    blobs = opts.blobs ?? (await openBlobStore(config));
  } catch (err) {
    if (!opts.db) await db.close();
    throw err;
  }
  const runArchive = opts.runArchive ?? new SqlRunArchive(db, blobs);
  const admin = await store.forUser(ADMIN_USER);
  // Each user's terminals and runs get their own `<dataDir>/reviewers/<user>.json` (written when one opens or starts,
  // and on every change); the instance-wide file is no longer used, so it is removed rather than left stale.
  await rm(reviewersFilePath(config.dataDir), { force: true }).catch(() => undefined);
  await writeReviewersFile(config.dataDir, admin.reviewers(), ADMIN_USER.id);
  const binDir = path.join(config.dataDir, "bin");
  // The per-boot token of `graph-execution --sandbox` in a terminal (KAN-88); only terminals get it.
  const internal = { token: opts.internalToken ?? randomBytes(32).toString("hex"), url: "" };
  const hasShim = writeGraphExecutionShim(binDir, config.graphExecutionBin, fileURLToPath(new URL("./shim.js", import.meta.url)));
  // `graph-manager-mcp`, the MCP server of graph-manager's tools; only when running from dist (mcp.js exists).
  const hasMcp = writeMcpShim(binDir, fileURLToPath(new URL("./mcp.js", import.meta.url)));
  // `claude --mcp-config` of Claude Code terminals (POST /api/terminals { agent: "claude" }).
  writeClaudeMcpConfig(config.dataDir);
  const termBinDir = hasShim || hasMcp ? binDir : undefined;
  const terminals = new TerminalManager({
    workspacesDir: config.workspacesDir,
    binDir: termBinDir,
    extraEnv: () => ({ GM_INTERNAL_TOKEN: internal.token, ...(internal.url ? { GM_INTERNAL_URL: internal.url } : {}) }),
  });
  const viewCache = new ViewCache({ dataDir: config.dataDir, workspacesDir: config.workspacesDir });
  const sandboxes = new Sandboxes({ config, store: admin, instanceId: store.instance().instanceId });
  // livePage() and the run listings ask it about sandboxed runs.
  setSandboxLookup(sandboxes);
  // Same base env, bin dir and reviewers file as the TerminalManager, so a terminal on a workspace gets today's env.
  const localHost = new LocalWorkspaceHost({
    workspacesDir: config.workspacesDir,
    graphExecutionBin: config.graphExecutionBin,
    dataDir: config.dataDir,
    binDir: termBinDir,
  });
  const userLifecycle = new UserLifecycle();
  // Sessions run locally with one account and in Docker with two or more (GM_SESSION_RUNTIME); a provisioner passed
  // in (tests, hosted deployments) replaces both.
  let dockerProvisioner: DockerProvisioner | undefined;
  let provisioner: SessionProvisioner;
  if (opts.provisioner) provisioner = opts.provisioner;
  else {
    dockerProvisioner = new DockerProvisioner({ config, store, sandboxes, docker: sandboxes.docker });
    provisioner = new RuntimeProvisioner({
      setting: config.sessionRuntime ?? "auto",
      countUsers: () => countUsers(db),
      local: new LocalProvisioner(localHost),
      docker: dockerProvisioner,
    });
  }
  // eslint-disable-next-line prefer-const -- the session manager's callbacks need the context it is part of
  let ctx: AppContext;
  const forgeAuth = async (user: User, forge: RepoRef["forge"]): Promise<GitAuth | undefined> => {
    const conn = connFor(ctx, await store.forUser(user), forge);
    return conn ? { forge, token: conn.token } : undefined;
  };
  const sessions = new SessionManager({
    store,
    provisioner,
    terminals,
    openTerminal: (user, p) => openTerminal(ctx, user, p),
    localHost,
    workspacesDir: config.workspacesDir,
    db,
    maxSessions: config.maxSessions,
    pollMs: opts.sessions?.pollMs,
    liveRuns: opts.sessions?.liveRuns,
    countUsers: () => countUsers(db),
    repoAccess: async (user, repo) => {
      const conn = connFor(ctx, await store.forUser(user), repo.forge);
      if (!conn) throw new ForgeError(400, `${repo.forge} is not connected`);
      const found = await forgeClient(conn).getRepo(`${repo.owner}/${repo.name}`);
      return { cloneUrl: found.cloneUrl, auth: { forge: repo.forge, token: conn.token } };
    },
    forgeAuth,
    // A session ends only after its hosted runs are finished and their containers released.
    hostedRunLive: (user, sessionId) => ctx.hostedRuns.activeFor(user, sessionId),
  });
  registerLoginHooks(sessions, store);
  // A disabled or deleted user's sessions end without asking (no push); then a deleted user's settings go with them.
  userLifecycle.onDisable((userId) => sessions.endAllOf(userId));
  userLifecycle.onDelete((userId) => sessions.endAllOf(userId));
  // And their session and run containers (left by a restart, or still starting).
  const docker = dockerProvisioner;
  if (docker) {
    userLifecycle.onDisable((userId) => docker.releaseUser(userId));
    userLifecycle.onDelete((userId) => docker.deleteUser(userId));
  }
  userLifecycle.onDelete((userId) => store.deleteUser(userId));
  // Their archived runs too: the rows and the blobs under runs/<userId>/.
  userLifecycle.onDelete((userId) => runArchive.deleteUser(userId));
  // Each run is archived under the users who own its clone (or project), never under someone else (F1).
  const archiver = new RunArchiver({
    archive: runArchive,
    store,
    workspacesDir: config.workspacesDir,
    dataDir: config.dataDir,
    users: async () => (await listUsers(db)).filter((u) => !u.disabled).map(toUser),
    owns: (user, workspaceId) => sessions.ownsWorkspace(user, workspaceId),
  });
  ctx = {
    config,
    store,
    db,
    terminals,
    viewCache,
    sandboxes,
    internal,
    tools: opts.tools ?? TOOLS,
    agentRequests: new AgentRequests(),
    localHost,
    hostFor: (workspaceId, user) => sessions.hostFor(user, workspaceId),
    provisioner,
    sessions,
    ...(config.sessionIdleMinutes !== undefined
      ? { idle: new IdleMonitor({ sessions, terminals, store, minutes: config.sessionIdleMinutes, forgeAuth }) }
      : {}),
    userLifecycle,
    runArchive,
    blobs,
    // Set right below: the monitor needs the context it is part of.
    hostedRuns: undefined as unknown as HostedRuns,
  };
  ctx.hostedRuns = new HostedRuns({ ctx, ...(opts.hostedRunsIntervalMs !== undefined ? { intervalMs: opts.hostedRunsIntervalMs } : {}) });
  opts.onContext?.(ctx);
  // Request logs carry no bodies (tokens arrive in later features); only method, url and status.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });
  app.decorate("adminStatus", adminStatus);
  app.decorate("ctx", ctx);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return reply.code(400).send({ error: `${where}${issue?.message ?? "invalid request"}` });
    }
    if (err instanceof ForgeError) {
      // A forge's 401/403 must not reach the browser as our own 401 (which means "log in again").
      return reply.code(err.status >= 400 && err.status < 500 ? 400 : 502).send({ error: err.message });
    }
    if (err instanceof HostError) return reply.code(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as Error).message });
    }
    req.log.error({ err }, "request failed");
    if (!opts.logger) console.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  app.addHook("onListen", async () => {
    const a = app.server.address();
    if (a && typeof a === "object") internal.url = `http://${loopbackHost(config.host)}:${a.port}`;
  });
  app.addHook("onClose", async () => terminals.disposeAll());
  app.addHook("onReady", async () => sessions.restore());
  // Every user's sandbox records (their own store) are looked up and cleaned up after a restart too.
  app.addHook("onReady", async () => {
    for (const u of await listUsers(db)) sandboxes.addStore(await store.forUser(toUser(u)));
  });
  // The idle loop runs only on a listening server (tests that only inject call `ctx.idle.check` themselves).
  const idle = ctx.idle;
  if (idle) {
    app.addHook("onListen", async () => idle.start());
    app.addHook("onClose", async () => idle.stop());
  }
  app.addHook("onClose", async () => sessions.stop());
  // `graph-execution manager users disable` only flags the row (another process): every minute, a disabled user's terminals and
  // sessions are ended as the gateway's disable does (their cookies stop working at once already).
  const disabledSweep = setInterval(() => {
    void (async () => {
      for (const row of await listUsers(db)) {
        if (!row.disabled) continue;
        const busy = terminals.listFor(row.id).length > 0 || Object.keys((await store.forUser(toUser(row))).get().sessions).length > 0;
        if (busy) await userLifecycle.disabled(row.id);
      }
    })().catch((err: unknown) => console.error(`ending disabled users' sessions failed: ${err instanceof Error ? err.message : String(err)}`));
  }, 60_000);
  disabledSweep.unref();
  app.addHook("onClose", async () => clearInterval(disabledSweep));
  ctx.hostedRuns.start();
  app.addHook("onClose", async () => ctx.hostedRuns.stop());
  if (opts.viewCache !== false) viewCache.start();
  app.addHook("onClose", async () => viewCache.stop());
  if (opts.archiver !== false) archiver.start();
  app.addHook("onClose", async () => archiver.stop());
  app.addHook("onClose", async () => clearSandboxLookup(sandboxes));
  // Last: the hooks above may still write. A db the caller passed is the caller's to close.
  if (!opts.db) app.addHook("onClose", async () => db.close());
  if (opts.startSandboxes) {
    app.addHook("onListen", async () => {
      void sandboxes.init();
    });
  }

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);
  await authRoutes(app, ctx);
  // The run-page proxy: an onRequest hook right after the auth hook, before body parsing.
  await proxyRoutes(app, ctx);

  // feature routes (one line per feature)
  await accountRoutes(app, ctx);
  await healthRoutes(app, ctx);
  await forgeRoutes(app, ctx);
  await terminalRoutes(app, ctx);
  // Before the workspace and run routes: its preHandler hook checks they are the user's.
  await sessionRoutes(app, ctx);
  await noticeRoutes(app, ctx);
  await runsRoutes(app, ctx);
  await prRoutes(app, ctx);
  await workspaceRoutes(app, ctx);
  await projectRoutes(app, ctx);
  await inspectRoutes(app, ctx);
  await specRoutes(app, ctx);
  await reviewerRoutes(app, ctx);
  await sandboxRoutes(app, ctx);
  await agentKeyRoutes(app, ctx);
  await resumeRoutes(app, ctx);
  await internalRoutes(app, ctx);
  await agentRequestRoutes(app, ctx);
  await gatewayRoutes(app, ctx);
  await uiRoutes(app, ctx);

  const webDir = opts.webDir ?? fileURLToPath(new URL("../web/", import.meta.url));
  const hasWeb = existsSync(webDir) && existsSync(`${webDir}/index.html`);
  if (hasWeb) await app.register(fastifyStatic, { root: webDir, wildcard: false, index: false });

  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split(/[?#]/, 1)[0] ?? "";
    const spa = (req.method === "GET" || req.method === "HEAD") && !pathname.startsWith("/api/") && pathname !== "/api" && !RUN_VIEW.test(pathname);
    if (spa && hasWeb) return reply.type("text/html").sendFile("index.html");
    return reply.code(404).send({ error: "not found" });
  });

  return app;
}
