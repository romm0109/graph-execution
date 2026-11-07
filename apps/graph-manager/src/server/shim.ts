// The `graph-execution` command of graph-manager's terminals (KAN-88). Without `--sandbox` it runs the engine
// (`GM_ENGINE_BIN`) as before; with `--sandbox` it asks graph-manager to start the run in a sandbox.
// Dependency-free on purpose (only `node:` imports): it starts fast and works from dist/server alone.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ShimPlan = { mode: "engine"; args: string[] } | { mode: "sandbox"; args: string[] } | { mode: "error"; message: string };

export interface ShimIo {
  cwd: string;
  fetch: typeof fetch;
  spawnEngine: (args: string[]) => Promise<number>;
  out: (s: string) => void;
  err: (s: string) => void;
}

const NOT_IN_TERMINAL = "graph-execution --sandbox works only in a graph-manager terminal";

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
  if (plan.mode === "engine") return io.spawnEngine(plan.args);

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
      body: JSON.stringify({ cwd: io.cwd, args: plan.args }),
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
function spawnEngine(bin: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const ignore = () => {};
    process.on("SIGINT", ignore);
    process.on("SIGTERM", ignore);
    const child = spawn(process.execPath, [bin, ...args], { stdio: "inherit" });
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
    spawnEngine: (args) => {
      if (!bin) {
        process.stderr.write("error: GM_ENGINE_BIN is not set\n");
        return Promise.resolve(2);
      }
      return spawnEngine(bin, args);
    },
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
  process.exitCode = code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
