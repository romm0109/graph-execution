import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { authRoutes } from "./auth.js";
import type { Config } from "./config.js";
import { ForgeError } from "./forges.js";
import { proxyRoutes } from "./proxy.js";
import { prRoutes } from "./routes/pr.js";
import { forgeRoutes } from "./routes/forges.js";
import { healthRoutes } from "./routes/health.js";
import { inspectRoutes } from "./routes/inspect.js";
import { runsRoutes } from "./routes/runs.js";
import { terminalRoutes } from "./routes/terminals.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { DataStore } from "./store.js";
import { TerminalManager, writeGraphExecutionShim } from "./terminals.js";
import { ViewCache } from "./viewcache.js";

/** What every feature route module gets. Later features may add optional fields. */
export interface AppContext {
  config: Config;
  store: DataStore;
  terminals: TerminalManager;
  /** Snapshots live run pages into `<dataDir>/views/`. */
  viewCache?: ViewCache;
}

export interface BuildAppOptions {
  store?: DataStore;
  /** Fastify's logger; off unless set. */
  logger?: boolean;
  /** The built UI to serve; defaults to `dist/web` next to `dist/server`. */
  webDir?: string;
  /** `false` turns off the background view cache (tests); on by default. */
  viewCache?: false;
}

const RUN_VIEW = /^\/runs\/[^/]+\/[^/]+\/view(\/|$)/;

export async function buildApp(config: Config, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const store = opts.store ?? (await DataStore.open(config.dataDir));
  const binDir = path.join(config.dataDir, "bin");
  const hasShim = writeGraphExecutionShim(binDir, config.graphExecutionBin);
  const terminals = new TerminalManager({ workspacesDir: config.workspacesDir, binDir: hasShim ? binDir : undefined });
  const viewCache = new ViewCache({ dataDir: config.dataDir, workspacesDir: config.workspacesDir });
  const ctx: AppContext = { config, store, terminals, viewCache };
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

  app.addHook("onClose", async () => terminals.disposeAll());
  if (opts.viewCache !== false) viewCache.start();
  app.addHook("onClose", async () => viewCache.stop());

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
