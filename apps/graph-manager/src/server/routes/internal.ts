// The terminals' internal API (KAN-88): `graph-execution … --sandbox` in a graph-manager terminal reaches it through
// the shim (src/server/shim.ts), authenticated with the per-boot GM_INTERNAL_TOKEN instead of the session cookie.
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { RUN_VALUE_OPTIONS } from "graph-execution/api";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { viewUrlOf } from "../runs.js";
import { SandboxError } from "../sandbox-run.js";
import { toolList } from "../tools/index.js";
import { listWorkspaces, resolveWorkspace, type Workspace } from "../workspaces.js";
import { resumeRun } from "./resume.js";
import { insideWorkspace, lastLines, newRunId, PROVIDERS } from "./runs.js";

const body = z.object({ cwd: z.string().min(1), args: z.array(z.string()).max(200) });
const toolCallBody = z.object({ terminalId: z.string().min(1), cwd: z.string().min(1), input: z.unknown().optional() });

/** Engine subcommands, which `--sandbox` does not apply to. */
const SUBCOMMANDS = new Set(["suite", "clean", "list", "open", "install", "readme", "skills"]);
/** Engine options that take a value (so the value is not taken for the tasks folder). */
const VALUE_OPTIONS = new Set(RUN_VALUE_OPTIONS);
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export interface ScannedArgs {
  positional: string[];
  spec?: string;
  provider?: string;
  reviewProvider?: string;
  run?: string;
  resume: boolean;
}

/** A small scanner of the engine's arguments: positionals and the options the server needs; the rest is ignored. */
export function scanArgs(args: string[]): ScannedArgs {
  const out: ScannedArgs = { positional: [], resume: false };
  const set = (name: string, value: string | undefined) => {
    if (name === "--spec") out.spec = value;
    else if (name === "--provider") out.provider = value;
    else if (name === "--review-provider") out.reviewProvider = value;
    else if (name === "--run") out.run = value;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      out.positional.push(...args.slice(i + 1));
      break;
    }
    if (a === "--resume") out.resume = true;
    else if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      set(a.slice(0, eq), a.slice(eq + 1));
    } else if (VALUE_OPTIONS.has(a)) set(a, args[++i]);
    else if (!a.startsWith("-")) out.positional.push(a);
  }
  return out;
}

/** The token check, in constant time over equal-length buffers. */
function tokenMatches(req: FastifyRequest, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  if (!m) return false;
  const given = Buffer.from(m[1]!);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** 401/403 for a request that is not a terminal of this server; undefined when it may pass. */
function denied(req: FastifyRequest, ctx: AppContext): { code: number; error: string } | undefined {
  if (!ctx.internal || !tokenMatches(req, ctx.internal.token)) return { code: 401, error: "bad internal token" };
  // Loopback, or graph-manager's own bound address when GM_HOST is a specific IP (127.0.0.1 doesn't listen then, so
  // terminals use that address): a TCP peer with the server's own address is this machine.
  if (!LOOPBACK.has(req.ip) && req.ip !== ctx.config.host) return { code: 403, error: "only from this machine" };
  return undefined;
}

/** The workspace whose path is `cwd` or contains it. */
async function workspaceOf(root: string, cwd: string): Promise<Workspace | undefined> {
  const abs = path.resolve(cwd);
  for (const ws of await listWorkspaces(root)) {
    if (abs === ws.path || abs.startsWith(ws.path + path.sep)) return ws;
  }
  return undefined;
}

export async function internalRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // The tools of `graph-manager-mcp` (src/server/mcp.ts) for agents in the terminals.
  app.get("/api/internal/tools", async (req, reply) => {
    const no = denied(req, ctx);
    if (no) return reply.code(no.code).send({ error: no.error });
    return { tools: toolList(ctx.tools) };
  });

  app.post<{ Params: { name: string } }>("/api/internal/tools/:name", async (req, reply) => {
    const no = denied(req, ctx);
    if (no) return reply.code(no.code).send({ error: no.error });
    const tool = ctx.tools.find((t) => t.name === req.params.name);
    if (!tool) return reply.code(404).send({ error: `unknown tool ${req.params.name}` });
    const { terminalId, cwd, input } = toolCallBody.parse(req.body ?? {});
    const terminal = ctx.terminals.get(terminalId);
    if (!terminal) return reply.code(400).send({ error: `unknown terminal ${terminalId}` });
    if (!path.isAbsolute(cwd)) return reply.code(400).send({ error: "cwd must be an absolute path" });
    const workspace = terminal.workspaceId
      ? resolveWorkspace(path.resolve(ctx.config.workspacesDir), terminal.workspaceId)
      : await workspaceOf(ctx.config.workspacesDir, cwd);
    const parsed = tool.input.safeParse(input ?? {});
    if (!parsed.success) return { text: `invalid arguments: ${z.prettifyError(parsed.error)}`, isError: true };
    try {
      return await tool.run(parsed.data, { ctx, terminal, workspace, cwd: path.resolve(cwd) });
    } catch (err) {
      req.log.error({ err }, `tool ${tool.name} failed`);
      return { text: (err as Error).message || String(err), isError: true };
    }
  });

  app.post("/api/internal/sandbox-runs", async (req, reply) => {
    const no = denied(req, ctx);
    if (no) return reply.code(no.code).send({ error: no.error });
    const internal = ctx.internal!;
    const { cwd, args } = body.parse(req.body ?? {});
    if (!path.isAbsolute(cwd)) return reply.code(400).send({ error: "cwd must be an absolute path" });
    const ws = await workspaceOf(ctx.config.workspacesDir, cwd);
    if (!ws) return reply.code(400).send({ error: "the terminal is not inside a workspace" });
    const engineArgs = args.filter((a) => a !== "--web" && a !== "--sandbox");
    const scan = scanArgs(engineArgs);
    const base = (process.env.GM_PUBLIC_URL || internal.url).replace(/\/+$/, "");

    try {
      if (scan.resume) {
        if (!scan.run) return reply.code(400).send({ error: "--resume --sandbox needs --run <id>" });
        const res = await resumeRun(ctx, ws, scan.run, { sandbox: true });
        return reply.code(201).send({ ...res, url: `${base}/runs/${ws.id}/${res.runId}` });
      }

      const first = scan.positional[0];
      if (first !== undefined && SUBCOMMANDS.has(first)) return reply.code(400).send({ error: "--sandbox works only for runs" });
      if (!scan.provider) return reply.code(400).send({ error: "missing required option --provider <name>" });
      if (!(PROVIDERS as readonly string[]).includes(scan.provider)) {
        return reply.code(400).send({ error: `--provider: unknown provider ${scan.provider} (${PROVIDERS.join("|")})` });
      }
      const rel = (p: string) => path.relative(ws.path, path.resolve(cwd, p));
      const tasksDir = first ?? "";
      if (!first || !insideWorkspace(ws, rel(first))) return reply.code(400).send({ error: `tasksDir: ${tasksDir} is not a folder inside the workspace` });
      const spec = scan.spec ?? "";
      if (!scan.spec || !insideWorkspace(ws, rel(scan.spec))) return reply.code(400).send({ error: `spec: ${spec} is not a file inside the workspace` });
      if (!ctx.sandboxes) return reply.code(400).send({ error: "sandboxes are not set up" });

      const runId = newRunId();
      // The args stay relative to cwd: the container mounts the workspace at the same path and starts in cwd.
      await ctx.sandboxes.start({ ws, cwd: path.resolve(cwd), args: engineArgs, runId, providers: [...new Set([scan.provider, ...(scan.reviewProvider && (PROVIDERS as readonly string[]).includes(scan.reviewProvider) ? [scan.reviewProvider] : [])])] });
      await ctx.store.update((d) => {
        d.workspaceSettings[ws.id] = { ...d.workspaceSettings[ws.id], sandbox: true };
      });
      return reply.code(201).send({ runId, viewUrl: viewUrlOf(ws.id, runId), url: `${base}/runs/${ws.id}/${runId}` });
    } catch (err) {
      if (err instanceof SandboxError) {
        return reply.code(err.status).send({ error: err.message, ...(err.output ? { output: lastLines(err.output, 20) } : {}) });
      }
      throw err;
    }
  });
}
