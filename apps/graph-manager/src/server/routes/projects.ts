import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { liveRunIn } from "../liverun.js";
import {
  PROJECT_NAME,
  ProjectFolderError,
  createProjectFolder,
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
  /** The project's folder (absolute). */
  path: string;
  createdAt: string;
  /** `repo`: the workspace's name under `repos/`. */
  workspaces: { id: string; fullPath: string; repo: string }[];
}

const createBody = z.object({ name: z.string().trim(), workspaces: z.array(z.string().min(1)) }).strict();
const patchBody = z.object({ workspaces: z.array(z.string().min(1)) }).strict();

type Checked = { ok: true; workspaces: Workspace[] } | { ok: false; status: number; error: string };

/** The workspaces of a project: no id twice, at least two, all known, one forge. */
function checkWorkspaces(root: string, ids: string[]): Checked {
  if (new Set(ids).size !== ids.length) return { ok: false, status: 400, error: "a workspace is listed twice" };
  if (ids.length < 2) return { ok: false, status: 400, error: "a project needs at least 2 workspaces" };
  const workspaces: Workspace[] = [];
  for (const id of ids) {
    const ws = resolveWorkspace(root, id);
    if (!ws) return { ok: false, status: 404, error: `unknown workspace ${id}` };
    workspaces.push(ws);
  }
  if (new Set(workspaces.map((w) => w.forge)).size > 1) {
    return { ok: false, status: 400, error: "all workspaces of a project must come from one forge" };
  }
  return { ok: true, workspaces };
}

async function viewOf(root: string, p: Project): Promise<ProjectView> {
  const dir = projectDirOf(root, p.id);
  const resolved = p.workspaces.map((id) => resolveWorkspace(root, id));
  // project.json lists the repos in the order of the record's workspaces.
  const file = await readProjectFile(dir);
  const fallback = repoNamesOf(resolved.filter((w): w is Workspace => w !== undefined));
  return {
    id: p.id,
    name: p.name,
    forge: p.workspaces[0]?.split("~")[0] ?? "",
    path: dir,
    createdAt: p.createdAt,
    workspaces: p.workspaces.map((id, i) => ({
      id,
      fullPath: resolved[i]?.fullPath ?? id.split("~").slice(1).join("/"),
      repo: (file?.repos.length === p.workspaces.length ? file.repos[i]?.name : undefined) ?? fallback.get(id) ?? "",
    })),
  };
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

  app.get("/api/projects", async () => Promise.all(ctx.store.projects().map((p) => viewOf(root, p))));

  app.post("/api/projects", async (req, reply) => {
    const body = createBody.parse(req.body);
    if (!PROJECT_NAME.test(body.name)) return reply.code(400).send({ error: "invalid project name: use letters, digits, - and _" });
    const checked = checkWorkspaces(root, body.workspaces);
    if (!checked.ok) return reply.code(checked.status).send({ error: checked.error });
    const id = projectIdOf(body.name);
    const existing = ctx.store.project(id);
    if (existing || reserved.has(id)) {
      return reply.code(409).send({ error: `a project named ${existing?.name ?? body.name} already exists` });
    }
    reserved.add(id);
    try {
      const project: Project = { id, name: body.name, workspaces: body.workspaces, createdAt: new Date().toISOString() };
      await createProjectFolder(root, project, checked.workspaces);
      try {
        await ctx.store.update((d) => {
          d.projects[id] = { name: project.name, workspaces: project.workspaces, createdAt: project.createdAt };
        });
      } catch (err) {
        await removeProjectFolder(root, id).catch(() => undefined);
        throw err;
      }
      return await reply.code(201).send(await viewOf(root, project));
    } catch (err) {
      return fail(reply, err);
    } finally {
      reserved.delete(id);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const body = patchBody.parse(req.body);
    const current = ctx.store.project(req.params.id);
    if (!current) return reply.code(404).send({ error: "project not found" });
    const checked = checkWorkspaces(root, body.workspaces);
    if (!checked.ok) return reply.code(checked.status).send({ error: checked.error });
    if (reserved.has(current.id)) return reply.code(409).send({ error: `project ${current.name} is being changed` });
    reserved.add(current.id);
    try {
      if (await liveRunIn(ctx, homeOf(current.id))) return await reply.code(409).send({ error: "a run of this project is live" });
      const project: Project = { ...current, workspaces: body.workspaces };
      await syncProjectFolder(root, project, checked.workspaces);
      await ctx.store.update((d) => {
        const rec = d.projects[project.id];
        if (rec) rec.workspaces = project.workspaces;
      });
      return await reply.send(await viewOf(root, project));
    } catch (err) {
      return fail(reply, err);
    } finally {
      reserved.delete(current.id);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const current = ctx.store.project(req.params.id);
    if (!current) return reply.code(404).send({ error: "project not found" });
    if (reserved.has(current.id)) return reply.code(409).send({ error: `project ${current.name} is being changed` });
    reserved.add(current.id);
    try {
      const home = homeOf(current.id);
      if (await liveRunIn(ctx, home)) return await reply.code(409).send({ error: "a run of this project is live" });
      for (const t of ctx.terminals.list()) {
        const cwd = path.resolve(t.cwd);
        if (t.projectId === current.id || cwd === home.path || cwd.startsWith(home.path + path.sep)) ctx.terminals.remove(t.id);
      }
      await removeProjectFolder(root, current.id);
      await ctx.store.update((d) => {
        delete d.projects[current.id];
      });
      return await reply.code(204).send();
    } finally {
      reserved.delete(current.id);
    }
  });
}
