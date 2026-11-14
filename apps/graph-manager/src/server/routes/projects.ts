import { existsSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { liveRunIn } from "../liverun.js";
import type { RepoRef } from "../host/types.js";
import { PROJECT_PREFIX } from "../runhome.js";
import { projectOf, projectsOf, type Data } from "../store.js";
import {
  PROJECT_NAME,
  ProjectFolderError,
  projectDirOf,
  projectIdOf,
  readProjectFile,
  removeProjectFolder,
  repoNamesOf,
  syncProjectFolder,
  type Project,
} from "../projects.js";
import { resolveWorkspace, type Workspace } from "../workspaces.js";

/** A project as the API gives it: `GET /api/projects` → `ProjectView[]`, and the body of POST 201 and PATCH 200. */
export interface ProjectView {
  id: string;
  name: string;
  forge: string;
  /** The project's folder (absolute); it exists once a project session has started. */
  path: string;
  createdAt: string;
  repos: RepoRef[];
  /** One per repository: its clone's workspace id, `owner/name`, and `repo`: its name under `repos/`. */
  workspaces: { id: string; fullPath: string; repo: string }[];
}

const repoBody = z
  .object({ forge: z.enum(["github", "gitlab"]), owner: z.string().min(1), name: z.string().min(1), baseUrl: z.string().url().optional() })
  .strict();
const createBody = z.object({ name: z.string().trim(), repos: z.array(repoBody) }).strict();
const patchBody = z.object({ repos: z.array(repoBody) }).strict();

const sameRepo = (a: RepoRef, b: RepoRef): boolean => a.forge === b.forge && a.owner === b.owner && a.name === b.name;

/** The repositories of a project: none twice, at least two, one forge. No clone and no forge call. */
function checkRepos(repos: RepoRef[]): string | undefined {
  if (repos.some((r, i) => repos.findIndex((o) => sameRepo(o, r)) !== i)) return "a repository is listed twice";
  if (repos.length < 2) return "a project needs at least 2 repositories";
  if (new Set(repos.map((r) => r.forge)).size > 1) return "all repositories of a project must come from one forge";
  return undefined;
}

const cleanRepo = (r: RepoRef): RepoRef => ({ forge: r.forge, owner: r.owner, name: r.name, ...(r.baseUrl !== undefined ? { baseUrl: r.baseUrl } : {}) });

async function viewOf(root: string, p: Project): Promise<ProjectView> {
  const dir = projectDirOf(root, p.id);
  // project.json lists the repos in the order of the record's repositories.
  const file = await readProjectFile(dir);
  const fallback = repoNamesOf(p.repos.map((r, i) => ({ id: p.workspaces[i]!, path: "", rel: "", forge: r.forge, fullPath: `${r.owner}/${r.name}` })));
  return {
    id: p.id,
    name: p.name,
    forge: p.repos[0]?.forge ?? "",
    path: dir,
    createdAt: p.createdAt,
    repos: p.repos,
    workspaces: p.repos.map((r, i) => {
      const id = p.workspaces[i]!;
      return {
        id,
        fullPath: `${r.owner}/${r.name}`,
        repo: (file?.repos.length === p.repos.length ? file.repos[i]?.name : undefined) ?? fallback.get(id) ?? r.name,
      };
    }),
  };
}

const liveSession = (name: string): string => `project ${name} has a live session. Close it first.`;

/** The user's session on the project (open, opening or closing), if any. */
function projectSession(d: Data, id: string): Data["sessions"][string] | undefined {
  return Object.values(d.sessions).find((s) => s.projectId === id || s.workspaceId === `${PROJECT_PREFIX}${id}`);
}

export async function projectRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const root = path.resolve(ctx.config.workspacesDir);
  /** Project ids a request is creating, changing or deleting right now. */
  const reserved = new Set<string>();
  const homeOf = (id: string) => ({ id: `project~${id}`, path: projectDirOf(root, id) });
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ProjectFolderError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };

  app.get("/api/projects", async (req) => Promise.all(projectsOf((await ctx.store.forUser(req.user)).get()).map((p) => viewOf(root, p))));

  app.post("/api/projects", async (req, reply) => {
    const us = await ctx.store.forUser(req.user);
    const body = createBody.parse(req.body);
    if (!PROJECT_NAME.test(body.name)) return reply.code(400).send({ error: "invalid project name: use letters, digits, - and _" });
    const repos = body.repos.map(cleanRepo);
    const invalid = checkRepos(repos);
    if (invalid !== undefined) return reply.code(400).send({ error: invalid });
    const id = projectIdOf(body.name);
    const existing = projectOf(us.get(), id);
    if (existing || reserved.has(id)) {
      return reply.code(409).send({ error: `a project named ${existing?.name ?? body.name} already exists` });
    }
    reserved.add(id);
    try {
      // No folder yet: a project session's prepare clones the repositories and writes it.
      const createdAt = new Date().toISOString();
      await us.update((d) => {
        d.projects[id] = { name: body.name, repos, createdAt };
      });
      return await reply.code(201).send(await viewOf(root, projectOf(us.get(), id)!));
    } finally {
      reserved.delete(id);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const us = await ctx.store.forUser(req.user);
    const body = patchBody.parse(req.body);
    const current = projectOf(us.get(), req.params.id);
    if (!current) return reply.code(404).send({ error: "project not found" });
    const repos = body.repos.map(cleanRepo);
    const invalid = checkRepos(repos);
    if (invalid !== undefined) return reply.code(400).send({ error: invalid });
    if (reserved.has(current.id)) return reply.code(409).send({ error: `project ${current.name} is being changed` });
    reserved.add(current.id);
    try {
      if (await liveRunIn(ctx, us, homeOf(current.id))) return await reply.code(409).send({ error: "a run of this project is live" });
      if (projectSession(us.get(), current.id)) return await reply.code(409).send({ error: liveSession(current.name) });
      await us.update((d) => {
        const rec = d.projects[current.id];
        if (rec) rec.repos = repos;
      });
      const project = projectOf(us.get(), current.id)!;
      // A folder of an earlier session follows now when every clone is here; else the next session's prepare syncs it.
      const workspaces = project.workspaces.map((w) => resolveWorkspace(root, w));
      if (existsSync(projectDirOf(root, project.id)) && workspaces.every((w) => w !== undefined)) {
        await syncProjectFolder(root, project, workspaces as Workspace[]);
      }
      return await reply.send(await viewOf(root, project));
    } catch (err) {
      return fail(reply, err);
    } finally {
      reserved.delete(current.id);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const us = await ctx.store.forUser(req.user);
    const current = projectOf(us.get(), req.params.id);
    if (!current) return reply.code(404).send({ error: "project not found" });
    if (reserved.has(current.id)) return reply.code(409).send({ error: `project ${current.name} is being changed` });
    reserved.add(current.id);
    try {
      const home = homeOf(current.id);
      if (await liveRunIn(ctx, us, home)) return await reply.code(409).send({ error: "a run of this project is live" });
      if (projectSession(us.get(), current.id)) return await reply.code(409).send({ error: liveSession(current.name) });
      for (const t of ctx.terminals.list()) {
        const cwd = path.resolve(t.cwd);
        if (t.projectId === current.id || cwd === home.path || cwd.startsWith(home.path + path.sep)) ctx.terminals.remove(t.id);
      }
      if (existsSync(home.path)) await removeProjectFolder(root, current.id);
      await us.update((d) => {
        delete d.projects[current.id];
      });
      return await reply.code(204).send();
    } finally {
      reserved.delete(current.id);
    }
  });
}
