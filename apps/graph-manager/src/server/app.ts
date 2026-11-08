import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AgentRequests } from "./agent-requests.js";
import { writeClaudeMcpConfig } from "./agents.js";
import { authRoutes } from "./auth.js";
import type { Config } from "./config.js";
import { ForgeError } from "./forges.js";
import { proxyRoutes } from "./proxy.js";
import { agentRequestRoutes } from "./routes/agent-requests.js";
import { prRoutes } from "./routes/pr.js";
import { reviewerRoutes } from "./routes/reviewers.js";
import { resumeRoutes } from "./routes/resume.js";
import { forgeRoutes } from "./routes/forges.js";
import { healthRoutes } from "./routes/health.js";
import { inspectRoutes } from "./routes/inspect.js";
import { internalRoutes } from "./routes/internal.js";
import { runsRoutes } from "./routes/runs.js";
import { sandboxRoutes } from "./routes/sandbox.js";
import { specRoutes } from "./routes/specs.js";
import { terminalRoutes } from "./routes/terminals.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { reviewersFilePath, writeReviewersFile } from "./reviewers.js";
import { clearSandboxLookup, setSandboxLookup } from "./runs.js";
import { Sandboxes } from "./sandbox.js";
import { DataStore } from "./store.js";
import { TerminalManager, writeGraphExecutionShim, writeMcpShim } from "./terminals.js";
import { TOOLS } from "./tools/index.js";
import type { GmTool } from "./tools/types.js";
import { ViewCache } from "./viewcache.js";

/** What every feature route module gets. Later features may add optional fields. */
export interface AppContext {
  config: Config;
  store: DataStore;
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
}

export interface BuildAppOptions {
  store?: DataStore;
  /** Fastify's logger; off unless set. */
  logger?: boolean;
  /** The built UI to serve; defaults to `dist/web` next to `dist/server`. */
  webDir?: string;
  /** `false` turns off the background view cache (tests); on by default. */
  viewCache?: false;
  /** Starts the sandbox service (Docker ping, network) once listening; main.ts sets it, tests do not. */
  startSandboxes?: boolean;
  /** Fixed internal token (tests); random otherwise. */
  internalToken?: string;
  /** Replaces the registry's tools (tests). */
  tools?: GmTool[];
}

/** The host terminals reach this server at: loopback unless it listens on one specific address. */
export function loopbackHost(host: string): string {
  if (host === "" || host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host.includes(":") ? `[${host}]` : host;
}

const RUN_VIEW = /^\/runs\/[^/]+\/[^/]+\/view(\/|$)/;

export async function buildApp(config: Config, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const store = opts.store ?? (await DataStore.open(config.dataDir));
  // Before any terminal or run starts: they get this file as GRAPH_EXECUTION_REVIEWERS.
  await writeReviewersFile(config.dataDir, store.reviewers());
  const binDir = path.join(config.dataDir, "bin");
  // The per-boot token of `graph-execution --sandbox` in a terminal (KAN-88); only terminals get it.
  const internal = { token: opts.internalToken ?? randomBytes(32).toString("hex"), url: "" };
  const hasShim = writeGraphExecutionShim(binDir, config.graphExecutionBin, fileURLToPath(new URL("./shim.js", import.meta.url)));
  // `graph-manager-mcp`, the MCP server of graph-manager's tools; only when running from dist (mcp.js exists).
  const hasMcp = writeMcpShim(binDir, fileURLToPath(new URL("./mcp.js", import.meta.url)));
  // `claude --mcp-config` of Claude Code terminals (POST /api/terminals { agent: "claude" }).
  writeClaudeMcpConfig(config.dataDir);
  const terminals = new TerminalManager({
    workspacesDir: config.workspacesDir,
    binDir: hasShim || hasMcp ? binDir : undefined,
    reviewersFile: reviewersFilePath(config.dataDir),
    extraEnv: () => ({ GM_INTERNAL_TOKEN: internal.token, ...(internal.url ? { GM_INTERNAL_URL: internal.url } : {}) }),
  });
  const viewCache = new ViewCache({ dataDir: config.dataDir, workspacesDir: config.workspacesDir });
  const sandboxes = new Sandboxes({ config, store });
  // livePage() and the run listings ask it about sandboxed runs.
  setSandboxLookup(sandboxes);
  const ctx: AppContext = { config, store, terminals, viewCache, sandboxes, internal, tools: opts.tools ?? TOOLS, agentRequests: new AgentRequests() };
  // Request logs carry no bodies (tokens arrive in later features); only method, url and status.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });

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
  if (opts.viewCache !== false) viewCache.start();
  app.addHook("onClose", async () => viewCache.stop());
  app.addHook("onClose", async () => clearSandboxLookup(sandboxes));
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
  await healthRoutes(app, ctx);
  await forgeRoutes(app, ctx);
  await terminalRoutes(app, ctx);
  await runsRoutes(app, ctx);
  await prRoutes(app, ctx);
  await workspaceRoutes(app, ctx);
  await inspectRoutes(app, ctx);
  await specRoutes(app, ctx);
  await reviewerRoutes(app, ctx);
  await sandboxRoutes(app, ctx);
  await resumeRoutes(app, ctx);
  await internalRoutes(app, ctx);
  await agentRequestRoutes(app, ctx);

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
