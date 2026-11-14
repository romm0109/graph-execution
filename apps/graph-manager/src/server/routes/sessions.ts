// Repo sessions (docs/prd/hosted-sessions.md): /api/sessions, the New terminal dialog's /api/repos, and the
// ownership check of every workspace and run route.
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AGENT_IDS } from "../agents.js";
import type { AppContext } from "../app.js";
import { connFor, forgeClient, gitAuthArgs, ForgeError, type ForgeKind } from "../forges.js";
import type { RepoRef } from "../host/types.js";
import { lastLine, scrub } from "../pr.js";
import { projectOf } from "../store.js";

const size = z.number().int().min(2).max(1000);
const terminalFields = {
  agent: z.enum(AGENT_IDS).optional(),
  cols: size.optional(),
  rows: size.optional(),
  title: z.string().max(200).optional(),
};
const forgeEnum = z.enum(["github", "gitlab"]);

const openBody = z
  .object({
    repo: z
      .object({ forge: forgeEnum, owner: z.string().min(1), name: z.string().min(1), baseUrl: z.string().min(1).optional() })
      .strict()
      .optional(),
    projectId: z.string().min(1).optional(),
    branch: z.union([z.object({ existing: z.string().min(1) }).strict(), z.object({ new: z.string().optional() }).strict()]).optional(),
    ...terminalFields,
  })
  .strict();

const terminalBody = z.object(terminalFields).strict();
const closeBody = z.object({ action: z.enum(["push", "keep", "discard"]) }).strict();
const branchesQuery = z.object({ forge: forgeEnum, owner: z.string().min(1), name: z.string().min(1) });

/** The route patterns whose workspace param must be the user's: [prefix, param]. */
const OWNED_ROUTES: Array<[RegExp, string]> = [
  [/^\/api\/runs\/:ws(\/|$)/, "ws"],
  [/^\/api\/workspaces\/:id(\/|$)/, "id"],
];

/**
 * Routes on a repository id that only read or write the user's own per-repository settings (Settings → Repositories),
 * keyed by the id alone: they work for a repository the user never opened, so no clone ownership is needed.
 */
const SETTINGS_ROUTES = new Set(["GET /api/workspaces/:id/settings", "PUT /api/workspaces/:id/settings", "GET /api/workspaces/:id/sandbox/build", "DELETE /api/workspaces/:id/run-defaults"]);

export async function sessionRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { sessions } = ctx;

  app.addHook("preHandler", async (req, reply) => {
    const url = req.routeOptions.url;
    if (url === undefined || SETTINGS_ROUTES.has(`${req.method} ${url}`)) return;
    for (const [re, param] of OWNED_ROUTES) {
      if (!re.test(url)) continue;
      const id = (req.params as Record<string, string | undefined>)[param];
      if (id !== undefined && !(await sessions.ownsWorkspace(req.user, id))) return reply.code(404).send({ error: "unknown workspace" });
    }
  });

  app.get("/api/sessions", async (req) => ({ sessions: await sessions.list(req.user), limit: ctx.config.maxSessions ?? null }));

  app.post("/api/sessions", async (req, reply) => {
    const body = openBody.parse(req.body ?? {});
    if ((body.repo === undefined) === (body.projectId === undefined)) return reply.code(400).send({ error: "pass repo or projectId" });
    const open = {
      ...(body.branch !== undefined ? { branch: body.branch } : {}),
      agent: body.agent,
      cols: body.cols,
      rows: body.rows,
      title: body.title,
    };
    if (body.projectId !== undefined) {
      const us = await ctx.store.forUser(req.user);
      const project = projectOf(us.get(), body.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      const gl = us.get().forges.gitlab;
      project.repos = project.repos.map((r) => (r.forge === "gitlab" && r.baseUrl === undefined && gl ? { ...r, baseUrl: gl.baseUrl } : r));
      return reply.code(201).send(await sessions.open(req.user, { project, ...open }));
    }
    if (body.repo === undefined) return reply.code(400).send({ error: "pass repo or projectId" });
    const repo: RepoRef = { forge: body.repo.forge, owner: body.repo.owner, name: body.repo.name };
    if (body.repo.baseUrl !== undefined) repo.baseUrl = body.repo.baseUrl;
    else if (repo.forge === "gitlab") {
      const gl = (await ctx.store.forUser(req.user)).get().forges.gitlab;
      if (gl) repo.baseUrl = gl.baseUrl;
    }
    const res = await sessions.open(req.user, { repo, ...open });
    return reply.code(201).send(res);
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/terminals", async (req, reply) => {
    const body = terminalBody.parse(req.body ?? {});
    const info = await sessions.openTerminal(req.user, req.params.id, body);
    return reply.code(201).send(info);
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/close", async (req) => {
    const body = closeBody.parse(req.body ?? {});
    return sessions.close(req.user, req.params.id, body.action);
  });

  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
    const res = await sessions.closeSession(req.user, req.params.id);
    if (res.ask) return reply.code(200).send({ sessionId: req.params.id, ask: res.ask });
    return reply.code(204).send();
  });

  app.get<{ Querystring: { q?: string } }>("/api/repos", async (req) => {
    const us = await ctx.store.forUser(req.user);
    const q = typeof req.query.q === "string" && req.query.q.trim() !== "" ? req.query.q.trim() : undefined;
    const mine = await sessions.list(req.user);
    const forges = { github: false, gitlab: false };
    const repos = [];
    for (const kind of ["github", "gitlab"] as const) {
      const conn = connFor(ctx, us, kind);
      if (!conn) continue;
      forges[kind] = true;
      const baseUrl = kind === "gitlab" ? us.get().forges.gitlab?.baseUrl : undefined;
      for (const r of await forgeClient(conn).listRepos(q)) {
        const parts = r.fullPath.split("/");
        const repo: RepoRef = { forge: kind, owner: parts.slice(0, -1).join("/"), name: parts[parts.length - 1] ?? r.name };
        if (baseUrl !== undefined) repo.baseUrl = baseUrl;
        const s = mine.find((x) => x.projectId === undefined && x.repo.forge === kind && x.repo.owner === repo.owner && x.repo.name === repo.name);
        repos.push({
          repo,
          fullPath: r.fullPath,
          defaultBranch: r.defaultBranch,
          private: r.private,
          webUrl: r.webUrl,
          live: s !== undefined,
          ...(s ? { sessionId: s.id, branch: s.branch } : {}),
        });
      }
    }
    // Live first, otherwise the forges' order.
    const sorted = [...repos.filter((r) => r.live), ...repos.filter((r) => !r.live)];
    return { repos: sorted, forges };
  });

  app.get("/api/repos/branches", async (req, reply) => {
    const query = branchesQuery.parse(req.query ?? {});
    const kind: ForgeKind = query.forge;
    const conn = connFor(ctx, await ctx.store.forUser(req.user), kind);
    if (!conn) throw new ForgeError(400, `${kind} is not connected`);
    const repo = await forgeClient(conn).getRepo(`${query.owner}/${query.name}`);
    const res = await execa("git", [...gitAuthArgs(kind, conn.token), "ls-remote", "--heads", "--", repo.cloneUrl], {
      reject: false,
      stdin: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 60_000,
    });
    if (res.exitCode !== 0) {
      const msg = lastLine(String(res.stderr ?? "") || String(res.stdout ?? "") || (res.message ?? "")) || `git exited ${String(res.exitCode)}`;
      return reply.code(502).send({ error: `cannot list branches: ${scrub(msg, conn.token)}` });
    }
    const names = String(res.stdout ?? "")
      .split("\n")
      .map((l) => l.split("\t")[1]?.trim() ?? "")
      .filter((ref) => ref.startsWith("refs/heads/"))
      .map((ref) => ref.slice("refs/heads/".length));
    const rest = names.filter((b) => b !== repo.defaultBranch).sort();
    return { defaultBranch: repo.defaultBranch, branches: names.includes(repo.defaultBranch) ? [repo.defaultBranch, ...rest] : rest };
  });
}
