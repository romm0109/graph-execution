import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { RUN_ID_ENV } from "graph-execution/api";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { isRunId, listRuns, listWorkspaceRuns, runDetail, viewUrlOf } from "../runs.js";
import { resolveWorkspace, type Workspace } from "../workspaces.js";

export const PROVIDERS = ["claude", "codex", "opencode", "qwen", "fake"] as const;

const startBody = z.object({
  tasksDir: z.string().min(1),
  spec: z.string().min(1),
  provider: z.enum(PROVIDERS),
  concurrency: z.number().int().min(1).max(64).optional(),
});

const START_TIMEOUT_MS = 120_000;
const INTERNAL_ENV = ["GRAPH_EXECUTION_RUNS_ROOT", "GRAPH_EXECUTION_READY_FILE", "GRAPH_EXECUTION_TASK_NAME"];

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

/** The graph-execution command line: `node <cli.js> …` for a `.js` bin, else the bin itself. */
export function engineCommand(bin: string, args: string[]): { file: string; args: string[] } {
  return /\.[cm]?js$/.test(bin) ? { file: process.execPath, args: [bin, ...args] } : { file: bin, args };
}

const lastLines = (text: string, n: number): string => text.trimEnd().split("\n").slice(-n).join("\n");

function workspaceOr404(ctx: AppContext, id: string): Workspace | undefined {
  return resolveWorkspace(ctx.config.workspacesDir, id);
}

export async function runsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Querystring: { workspace?: string } }>("/api/runs", async (req) => {
    const filter = req.query.workspace;
    const prs = ctx.store.get().prs;
    if (filter) {
      const ws = workspaceOr404(ctx, filter);
      return { runs: ws ? await listWorkspaceRuns(ws, prs, ctx.config.dataDir) : [] };
    }
    return { runs: await listRuns(ctx.config.workspacesDir, prs, ctx.config.dataDir) };
  });

  app.get<{ Params: { ws: string; runId: string } }>("/api/runs/:ws/:runId", async (req, reply) => {
    if (!isRunId(req.params.runId)) return reply.code(400).send({ error: "invalid run id" });
    const ws = workspaceOr404(ctx, req.params.ws);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    const detail = await runDetail(ws, req.params.runId, ctx.config.dataDir);
    if (!detail) return reply.code(404).send({ error: "unknown run" });
    return detail;
  });

  app.post<{ Params: { ws: string } }>("/api/runs/:ws", async (req, reply) => {
    const ws = workspaceOr404(ctx, req.params.ws);
    if (!ws) return reply.code(404).send({ error: "unknown workspace" });
    const body = startBody.parse(req.body ?? {});
    const tasksDir = insideWorkspace(ws, body.tasksDir);
    if (!tasksDir) return reply.code(400).send({ error: `tasksDir: ${body.tasksDir} is not a folder inside the workspace` });
    const spec = insideWorkspace(ws, body.spec);
    if (!spec) return reply.code(400).send({ error: `spec: ${body.spec} is not a file inside the workspace` });

    const runId = newRunId();
    const args = [body.tasksDir, "--spec", body.spec, "--provider", body.provider, "--web"];
    if (body.concurrency !== undefined) args.push("--concurrency", String(body.concurrency));
    const env: NodeJS.ProcessEnv = { ...process.env, GRAPH_EXECUTION_HANDOFF: "detached", SSH_CONNECTION: "1", [RUN_ID_ENV]: runId };
    delete env.GM_PASSWORD;
    // Internal variables that would tie the new run to another run's folder or launcher.
    for (const name of INTERNAL_ENV) delete env[name];
    const cmd = engineCommand(ctx.config.graphExecutionBin, args);
    const res = await execa(cmd.file, cmd.args, {
      cwd: ws.path,
      env,
      extendEnv: false,
      reject: false,
      all: true,
      stdin: "ignore",
      timeout: START_TIMEOUT_MS,
    });
    if (res.exitCode !== 0) {
      const output = typeof res.all === "string" && res.all.trim() !== "" ? res.all : (res.message ?? "");
      const tail = lastLines(output, 20);
      const exitCode = typeof res.exitCode === "number" ? res.exitCode : undefined;
      return reply.code(400).send({ error: tail || `graph-execution exited ${String(res.exitCode)}`, exitCode, output: tail });
    }
    // The run id we set reaches the detached run (GRAPH_EXECUTION_* variables pass through); trust stdout if it differs.
    const printed = /\b(?:Started run|Run) (\S+)(?: in the background)?(?::| started:)/.exec(res.stdout)?.[1];
    const id = printed && isRunId(printed) ? printed : runId;
    return reply.code(201).send({ runId: id, viewUrl: viewUrlOf(ws.id, id) });
  });
}
