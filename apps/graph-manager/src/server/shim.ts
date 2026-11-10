// The `graph-execution` command of graph-manager's terminals (KAN-88). Without `--sandbox` it runs the engine
// (`GM_ENGINE_BIN`) as before; with `--sandbox` it asks graph-manager to start the run in a sandbox. Either way it tells
// graph-manager which terminal started the run, its origin (docs/prd/agent-supervisor.md): for an engine run it picks
// the run id itself (GRAPH_EXECUTION_RUN_ID) and registers it before spawning the engine.
// Dependency-free on purpose (only `node:` imports): it starts fast and works from dist/server alone.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ShimPlan = { mode: "engine"; args: string[] } | { mode: "sandbox"; args: string[] } | { mode: "error"; message: string };

export interface ShimIo {
  cwd: string;
  fetch: typeof fetch;
  /** Runs the engine; `env` is added to its environment. */
  spawnEngine: (args: string[], env?: Record<string, string>) => Promise<number>;
  out: (s: string) => void;
  err: (s: string) => void;
}

const NOT_IN_TERMINAL = "graph-execution --sandbox works only in a graph-manager terminal";
/** Engine subcommands, which start no run (a copy of SUBCOMMANDS in routes/internal.ts). */
const SUBCOMMANDS = new Set(["suite", "clean", "list", "open", "install", "readme", "skills"]);
/** Options that start no run. */
const NO_RUN = new Set(["--help", "-h", "--version", "-V", "--web-serve"]);
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A run id like graph-manager's own (`newRunId` in routes/runs.ts): `gm-<yyyymmdd>-<hhmmss>-<4 hex>`, local time. */
export function shimRunId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `gm-${date}-${time}-${randomBytes(2).toString("hex")}`;
}

/**
 * The run this command starts or resumes, and whether the shim must pass its id to the engine
 * (GRAPH_EXECUTION_RUN_ID); undefined when it starts none (subcommands, `--help`, `--resume` without `--run`).
 */
export function originOf(args: string[], env: NodeJS.ProcessEnv): { runId: string; setEnv: boolean } | undefined {
  if (args.some((a) => NO_RUN.has(a))) return undefined;
  const first = args.find((a) => !a.startsWith("-"));
  if (first !== undefined && SUBCOMMANDS.has(first)) return undefined;
  let origin: { runId: string; setEnv: boolean } | undefined;
  if (args.includes("--resume")) {
    let run: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--run") run = args[i + 1];
      else if (a.startsWith("--run=")) run = a.slice("--run=".length);
    }
    origin = run === undefined ? undefined : { runId: run, setEnv: false };
  } else if (env.GRAPH_EXECUTION_RUN_ID) {
    origin = { runId: env.GRAPH_EXECUTION_RUN_ID, setEnv: false };
  } else {
    origin = { runId: shimRunId(), setEnv: true };
  }
  return origin && RUN_ID.test(origin.runId) ? origin : undefined;
}

/** Tells graph-manager the terminal that starts `runId`; best effort, silent on any failure. */
async function registerOrigin(base: string, token: string, terminalId: string, cwd: string, runId: string, resume: boolean, io: ShimIo): Promise<void> {
  try {
    await io.fetch(`${base.replace(/\/+$/, "")}/api/internal/run-origins`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      // `resume` lets the watcher report `resumed` and the resumed attempt's end even when the status doesn't change.
      body: JSON.stringify({ terminalId, cwd, runId, ...(resume ? { resume: true } : {}) }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // best effort: the run starts anyway, only without an origin
  }
}

/** What the shim does with these arguments. */
export function planShim(args: string[]): ShimPlan {
  if (!args.includes("--sandbox")) return { mode: "engine", args: [...args] };
  if (args.includes("--web-serve")) return { mode: "error", message: "--web-serve is internal" };
  // The server always serves the run page, so `--web` is implied.
  return { mode: "sandbox", args: args.filter((a) => a !== "--sandbox" && a !== "--web") };
}

/** Runs the shim; returns its exit code. */
export async function runShim(argv: string[], env: NodeJS.ProcessEnv, io: ShimIo): Promise<number> {
  const plan = planShim(argv);
  if (plan.mode === "error") {
    io.err(`error: ${plan.message}\n`);
    return 2;
  }
  if (plan.mode === "engine") {
    const { GM_INTERNAL_URL: url, GM_INTERNAL_TOKEN: tok, GM_TERMINAL_ID: terminalId } = env;
    const origin = url && tok && terminalId ? originOf(plan.args, env) : undefined;
    if (!origin) return io.spawnEngine(plan.args);
    await registerOrigin(url!, tok!, terminalId!, io.cwd, origin.runId, plan.args.includes("--resume"), io);
    return origin.setEnv ? io.spawnEngine(plan.args, { GRAPH_EXECUTION_RUN_ID: origin.runId }) : io.spawnEngine(plan.args);
  }

  const base = env.GM_INTERNAL_URL;
  const token = env.GM_INTERNAL_TOKEN;
  if (!base || !token) {
    io.err(`error: ${NOT_IN_TERMINAL}\n`);
    return 2;
  }
  const url = `${base.replace(/\/+$/, "")}/api/internal/sandbox-runs`;
  let res: Response;
  try {
    res = await io.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ cwd: io.cwd, args: plan.args, ...(env.GM_TERMINAL_ID ? { terminalId: env.GM_TERMINAL_ID } : {}) }),
    });
  } catch (e) {
    const cause = (e as { cause?: { message?: string } }).cause?.message;
    io.err(`error: graph-manager did not answer at ${base}: ${cause ?? (e as Error).message}\n`);
    return 2;
  }
  let body: { runId?: string; url?: string; error?: string; output?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // not JSON
  }
  if (res.status === 201 && body.runId) {
    io.out(`Run ${body.runId} started in a sandbox: ${body.url ?? ""}\n`);
    return 0;
  }
  io.err(`error: ${body.error ?? `graph-manager answered ${res.status}`}\n`);
  if (body.output) io.err(`${body.output.trimEnd()}\n`);
  return 2;
}

/** Runs `node <bin> <args>` in the foreground; Ctrl+C reaches it through the terminal's process group. */
function spawnEngine(bin: string, args: string[], env?: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ignore = () => {};
    process.on("SIGINT", ignore);
    process.on("SIGTERM", ignore);
    const child = spawn(process.execPath, [bin, ...args], { stdio: "inherit", env: { ...process.env, ...env } });
    const done = (code: number) => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", ignore);
      resolve(code);
    };
    child.on("error", (e) => {
      process.stderr.write(`error: ${e.message}\n`);
      done(2);
    });
    child.on("exit", (code, signal) => done(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1)));
  });
}

async function main(): Promise<void> {
  const bin = process.env.GM_ENGINE_BIN;
  const code = await runShim(process.argv.slice(2), process.env, {
    cwd: process.cwd(),
    fetch: globalThis.fetch,
    spawnEngine: (args, env) => {
      if (!bin) {
        process.stderr.write("error: GM_ENGINE_BIN is not set\n");
        return Promise.resolve(2);
      }
      return spawnEngine(bin, args, env);
    },
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
  process.exitCode = code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
