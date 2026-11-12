// `graph-execution <tasks> … --sandbox`: the whole run in a Docker container started with the local `docker` CLI, with
// no graph-manager. The host checks the run, builds (or checks) the image, copies the provider logins in, starts the
// container running `--web-serve`, waits for its page and opens it. Mirrors graph-manager's
// apps/graph-manager/src/server/sandbox.ts (start) and sandbox-run.ts (env, login files, git identity).
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { repoRoot } from "../git/git.js";
import { assertNotRunning, preflight, type PreflightOptions, UsageError } from "../launch/preflight.js";
import { providerInfo, loginEnvKeys } from "../providers/catalog.js";
import { openInBrowser } from "../readme/readme.js";
import { readRunReviewers } from "../review/reviewers.js";
import { generateRunId } from "../runner/startup.js";
import { EXIT_ABORT, EXIT_SUCCESS, type ExitCode } from "../state/errors.js";
import {
  RUN_ENV_UNSET,
  RUN_ID_ENV,
  RUN_VALUE_OPTIONS,
  RUNS_DIR,
  SANDBOX_ENV,
  SANDBOX_IMAGE_ENV,
  SANDBOX_SETTINGS_ENV,
  TAKE_LOCK_FROM_ENV,
  WEB_HOST_ENV,
  WEB_PORT_ENV,
  WEB_PUBLIC_PORT_ENV,
  WEB_TOKEN_ENV,
} from "../state/paths.js";
import { readLock, type SandboxState } from "../state/state.js";
import { build, cp, create, DOCKER_MISSING, dockerAvailable, type DockerOptions, type Exec, defaultExec, imageExists, imagePath, inspect, logs, rm as removeContainer, start } from "./docker.js";
import { ensureEngineCopy } from "./engine.js";
import { resolveImage } from "./image.js";
import { readSandboxRecord, SANDBOX_FILE, type SandboxRecord, sandboxPageUrl } from "./liveness.js";
import { firstSandboxFlag, resolveSandboxSettings, type SandboxFlags, type SandboxSettings } from "./settings.js";

export { readSandboxRecord, SANDBOX_FILE, type SandboxRecord, sandboxLiveness, sandboxPageUrl } from "./liveness.js";

/** The run page's port inside the container. */
export const SANDBOX_PORT = 7600;
/** The sandbox user's HOME in the container (the image makes it world-writable). */
export const SANDBOX_HOME = "/home/sandbox";
/** Where the engine copy is mounted, read-only. */
export const ENGINE_MOUNT = "/opt/graph-execution";
/** The Debian default PATH, for an image whose config has none. */
const DEFAULT_IMAGE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** The prefix of the container's name: `ge-sbx-<run id>`. */
export const CONTAINER_PREFIX = "ge-sbx-";

export const containerName = (runId: string): string => `${CONTAINER_PREFIX}${runId}`;

export interface SandboxStartOptions {
  /** The user's arguments (without the node and script paths). */
  args: string[];
  cwd: string;
  /** The run's checks; `resume` makes it a `--resume --sandbox`. */
  preflight: PreflightOptions;
  /** The `--sandbox-*` flags. */
  flags: SandboxFlags;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface SandboxStartDeps {
  exec?: Exec;
  /** Opens `url`; resolves false when no browser could be opened. */
  open?: (url: string) => Promise<boolean>;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** How long to wait for the page (default 60 s). */
  readyTimeoutMs?: number;
  /** The engine copy to mount (default: `ensureEngineCopy()`). */
  engineCopy?: () => Promise<string>;
  /** The HOME the login files are read from (default: `$HOME`, else the OS's). */
  home?: string;
}

/** The run flags that are dropped from the container's command, without a value. */
const DROPPED_SWITCHES = new Set(["--sandbox", "--web", "--no-sandbox-config-lines"]);
/** The run flags that are dropped with their value. */
const DROPPED_VALUED = new Set(["--sandbox-image", "--sandbox-base", "--sandbox-line", "--sandbox-cpus", "--sandbox-memory", "--sandbox-pids"]);

/** The user's arguments without `--sandbox`, `--web` and the `--sandbox-*` flags; other options' values are kept as is. */
export function containerArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      out.push(...args.slice(i));
      break;
    }
    const name = arg.startsWith("--") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (DROPPED_SWITCHES.has(arg)) continue;
    if (DROPPED_VALUED.has(name)) {
      if (name === arg) i++; // `--flag value`
      continue;
    }
    out.push(arg);
    if (RUN_VALUE_OPTIONS.includes(arg) && i + 1 < args.length) out.push(args[++i]!);
  }
  return out;
}

/** `GRAPH_EXECUTION_*` variables that tie a process to its launcher, run or sandbox: never passed in from the host. */
function internalVar(name: string): boolean {
  if (name in RUN_ENV_UNSET) return true;
  return (
    name === "GRAPH_EXECUTION_HANDOFF" ||
    name === TAKE_LOCK_FROM_ENV ||
    name.startsWith("GRAPH_EXECUTION_SANDBOX") ||
    name.startsWith("GRAPH_EXECUTION_WEB_") ||
    name.startsWith("GRAPH_EXECUTION_DELEGATE")
  );
}

const IDENTITY = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const;

/** The repository's git identity as `GIT_AUTHOR_*` / `GIT_COMMITTER_*` (the sandbox HOME has no git config). */
export async function gitIdentity(cwd: string): Promise<Record<string, string>> {
  const get = async (key: string): Promise<string | undefined> => {
    const res = await execa("git", ["config", "--get", key], { cwd, reject: false });
    const v = typeof res.stdout === "string" ? res.stdout.trim() : "";
    return res.exitCode === 0 && v !== "" ? v : undefined;
  };
  const [name, email] = await Promise.all([get("user.name"), get("user.email")]);
  const out: Record<string, string> = {};
  if (name !== undefined) out.GIT_AUTHOR_NAME = out.GIT_COMMITTER_NAME = name;
  if (email !== undefined) out.GIT_AUTHOR_EMAIL = out.GIT_COMMITTER_EMAIL = email;
  return out;
}

export interface SandboxEnvParams {
  runId: string;
  runDir: string;
  image: string;
  hostPort: number;
  token: string;
  /** `sandbox.env` of the config: more names passed from the host. */
  names: readonly string[];
  gitIdentity: Record<string, string>;
  imagePath?: string;
  settings?: Omit<SandboxState, "image">;
  takeLockFrom?: string;
}

/** The container's environment as `K=V`. Never a `GM_*` variable, nor the host's HOME or PATH. */
export function sandboxEnv(base: NodeJS.ProcessEnv, p: SandboxEnvParams): string[] {
  const vars = new Map<string, string>();
  const passed = new Set<string>([...loginEnvKeys(), ...IDENTITY, "TZ", "LANG", ...p.names]);
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (passed.has(k) || (k.startsWith("GRAPH_EXECUTION_") && !internalVar(k))) vars.set(k, v);
  }
  for (const k of IDENTITY) {
    const v = p.gitIdentity[k];
    if (v !== undefined && !vars.has(k)) vars.set(k, v);
  }
  const set: [string, string][] = [
    [SANDBOX_ENV, "1"],
    [SANDBOX_IMAGE_ENV, p.image],
    ...(p.settings ? ([[SANDBOX_SETTINGS_ENV, JSON.stringify(p.settings)]] as [string, string][]) : []),
    [RUN_ID_ENV, p.runId],
    [WEB_HOST_ENV, "0.0.0.0"],
    [WEB_PORT_ENV, String(SANDBOX_PORT)],
    [WEB_PUBLIC_PORT_ENV, String(p.hostPort)],
    [WEB_TOKEN_ENV, p.token],
    // A path inside the Linux container: always "/" separators, whatever the host.
    ["GRAPH_EXECUTION_READY_FILE", path.posix.join(p.runDir, ".ready.json")],
    ["HOME", SANDBOX_HOME],
    // Docker does not expand `$PATH` in an env value: the image's own.
    ["PATH", p.imagePath || DEFAULT_IMAGE_PATH],
    ...(p.takeLockFrom ? ([[TAKE_LOCK_FROM_ENV, p.takeLockFrom]] as [string, string][]) : []),
  ];
  for (const [k, v] of set) vars.set(k, v);
  return [...vars].map(([k, v]) => `${k}=${v}`);
}

/** One login file to copy: its path relative to HOME and on the host. */
interface LoginFile {
  rel: string;
  src: string;
}

async function walkFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walkFiles(dir, r)));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

const isFile = (p: string): Promise<boolean> => stat(p).then((s) => s.isFile(), () => false);
const isDir = (p: string): Promise<boolean> => stat(p).then((s) => s.isDirectory(), () => false);

/**
 * The login files of the providers (catalog `loginFiles`, relative to HOME; a trailing `/` is a folder). A provider
 * other than `fake` with no file and none of its `loginEnv` set throws: its agents could not log in.
 */
export async function loginFiles(providers: readonly string[], home: string, env: NodeJS.ProcessEnv): Promise<LoginFile[]> {
  const files = new Map<string, string>();
  for (const p of new Set(providers)) {
    if (p === "fake") continue;
    const info = providerInfo(p);
    if (!info) continue;
    let found = 0;
    for (const rel of info.loginFiles) {
      if (rel.endsWith("/")) {
        const folder = rel.slice(0, -1);
        const src = path.join(home, folder);
        if (!(await isDir(src))) continue;
        found++;
        for (const f of await walkFiles(src)) files.set(`${folder}/${f}`, path.join(src, f));
      } else {
        const src = path.join(home, rel);
        if (!(await isFile(src))) continue;
        found++;
        files.set(rel, src);
      }
    }
    if (found === 0 && !info.loginEnv.some((k) => (env[k] ?? "") !== "")) {
      throw new UsageError(`no ${p} login to copy into the sandbox: log in once, or set ${info.loginEnv[0] ?? "an API key"}`);
    }
  }
  return [...files].sort(([a], [b]) => a.localeCompare(b)).map(([rel, src]) => ({ rel, src }));
}

/** Copies the login files into a fresh 0700 folder (files 0600, folders 0700) and resolves with it. */
async function stageLogins(files: readonly LoginFile[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ge-sbx-login-"));
  await chmod(dir, 0o700);
  for (const f of files) {
    const dest = path.join(dir, ...f.rel.split("/"));
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    await copyFile(f.src, dest);
    await chmod(dest, 0o600);
  }
  // mkdir's mode is masked by the umask: set the folders again.
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.rel.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(path.join(dir, ...parts.slice(0, i)));
  }
  for (const d of dirs) await chmod(d, 0o700);
  return dir;
}

/** A free TCP port on 127.0.0.1: listen on port 0, read the port, close. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** True when `p` is `root` or inside it (both resolved through symlinks when they exist). */
function inside(p: string, root: string): boolean {
  const real = (x: string): string => (existsSync(x) ? realpathSync.native(x) : path.resolve(x));
  const rel = path.relative(real(root), real(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Where the image comes from and what the run records. */
interface ImagePlan {
  resolved: ReturnType<typeof resolveImage>;
  settings: Pick<SandboxSettings, "cpus" | "memoryMb" | "pids" | "env">;
  /** Recorded in state.json `sandbox` (with the image). */
  record: Omit<SandboxState, "image">;
}

/**
 * Starts a run, or resumes one (`preflight.resume`), in a new sandbox container. Throws UsageError for what can be
 * refused before anything is created; resolves with the exit code.
 */
export async function startSandboxedRun(opts: SandboxStartOptions, deps: SandboxStartDeps = {}): Promise<ExitCode> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const out = deps.out ?? ((text: string) => void process.stdout.write(`${text}\n`));
  const err = deps.err ?? ((text: string) => void process.stderr.write(`${text}\n`));
  if (platform === "win32") throw new UsageError("the sandbox needs Linux or macOS; on Windows use WSL");
  if (env[SANDBOX_ENV] === "1") throw new UsageError("already running in a sandbox");
  const resuming = opts.preflight.resume === true;
  if (resuming) {
    const flag = firstSandboxFlag(opts.flags);
    if (flag) throw new UsageError(`${flag} cannot be used with --resume; the run keeps the sandbox it started with`);
  }
  const docker: DockerOptions = { cwd: opts.cwd, exec: deps.exec ?? defaultExec(opts.cwd) };
  if (!(await dockerAvailable(docker))) throw new UsageError(DOCKER_MISSING);

  const pre = await preflight({ ...opts.preflight, skipProviderCheck: true });
  const repo = pre.kind === "run" ? pre.env.repo : pre.repo;
  const gitTop = await repoRoot(opts.cwd);

  let runId: string;
  let runDir: string;
  let providers: string[];
  let plan: ImagePlan;
  let takeLockFrom: string | undefined;
  let args = containerArgs(opts.args);
  if (pre.kind === "run") {
    // Only the repository is mounted: inputs outside it would not be there.
    const files = [opts.preflight.tasksDir!, opts.preflight.spec!, ...(pre.reviewersFile ? [pre.reviewersFile] : [])];
    for (const f of files) {
      if (!inside(path.resolve(opts.cwd, f), gitTop)) {
        throw new UsageError(`the sandbox mounts only the repository (${gitTop}): ${f} is outside it`);
      }
    }
    providers = [opts.preflight.provider!, ...(pre.reviewProvider ? [pre.reviewProvider] : []), ...pre.reviewers.flatMap((r) => (r.provider ? [r.provider] : []))];
    const settings = resolveSandboxSettings(pre.env.config, opts.flags);
    const resolved = resolveImage(settings, [...new Set(providers)]);
    plan = {
      resolved,
      settings,
      record: {
        ...(resolved.kind === "build" ? { base: settings.base, lines: settings.lines } : {}),
        cpus: settings.cpus,
        memoryMb: settings.memoryMb,
        pids: settings.pids,
      },
    };
    runId = generateRunId();
    runDir = path.join(repo, RUNS_DIR, runId);
  } else {
    const { state } = pre.store;
    runId = state.runId;
    runDir = pre.runDir;
    const record = await readSandboxRecord(runDir);
    const name = record?.container ?? containerName(runId);
    const old = await inspect(name, docker);
    if (old?.running) throw new UsageError("the run's sandbox is still running");
    if (!record) await assertNotRunning(runDir);
    if (old) await removeContainer(name, { ...docker, force: true });
    const lock = await readLock(runDir).catch(() => undefined);
    takeLockFrom = lock?.foreign ? lock.host : record?.hostname;
    const reviewers = await readRunReviewers(runDir, { reviewProvider: state.reviewProvider, reviewModel: state.reviewModel }).catch(() => []);
    providers = [state.provider, ...(state.reviewProvider ? [state.reviewProvider] : []), ...reviewers.flatMap((r) => (r.provider ? [r.provider] : []))];
    // The saved settings, over the config's (for a run that has none, e.g. one first started without a sandbox).
    const current = resolveSandboxSettings(pre.config, { sandbox: true });
    const saved = state.sandbox;
    const built = saved !== undefined && (saved.base !== undefined || saved.lines !== undefined);
    const settings: SandboxSettings = saved
      ? {
          ...(built ? {} : saved.image ? { image: saved.image } : {}),
          base: saved.base ?? current.base,
          lines: saved.lines ?? [],
          cpus: saved.cpus ?? current.cpus,
          memoryMb: saved.memoryMb ?? current.memoryMb,
          pids: saved.pids ?? current.pids,
          env: current.env,
        }
      : current;
    const resolved = resolveImage(settings, [...new Set(providers)]);
    plan = {
      resolved,
      settings,
      record: {
        ...(resolved.kind === "build" ? { base: settings.base, lines: settings.lines } : {}),
        cpus: settings.cpus,
        memoryMb: settings.memoryMb,
        pids: settings.pids,
      },
    };
    if (!args.includes("--run") && !args.some((a) => a.startsWith("--run="))) args = [...args, "--run", runId];
  }
  providers = [...new Set(providers)];
  // Refused before anything is created: a provider whose agents could not log in.
  const logins = await loginFiles(providers, deps.home ?? env.HOME ?? os.homedir(), env);

  // The image.
  let image: string;
  if (plan.resolved.kind === "build") {
    image = plan.resolved.tag;
    if (!(await imageExists(image, docker))) {
      out(`Building the sandbox image ${image}…`);
      try {
        await build(plan.resolved.dockerfile, image, { ...docker, onLine: out });
      } catch (e) {
        throw new UsageError(
          `building the sandbox image failed; the base image needs glibc, node >= 20, npm and git\n${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } else {
    image = plan.resolved.image;
    for (const p of providers) {
      const bin = providerInfo(p)?.bin;
      if (!bin) continue;
      const r = await docker.exec!(["run", "--rm", "--entrypoint", "sh", image, "-c", `command -v ${bin}`]);
      if (r.exitCode !== 0) throw new UsageError(`image ${image} has no ${bin} on its PATH`);
    }
  }
  const pathOfImage = await imagePath(image, docker).catch(() => undefined);
  const engine = await (deps.engineCopy ?? (() => ensureEngineCopy({ log: out })))();

  // The container.
  await mkdir(runDir, { recursive: true });
  const readyFile = path.join(runDir, ".ready.json");
  await rm(readyFile, { force: true });
  const owner = await stat(gitTop);
  const hostname = `sbx-${randomBytes(4).toString("hex")}`;
  const token = randomBytes(24).toString("base64url");
  const hostPort = await freePort();
  const name = containerName(runId);
  const vars = sandboxEnv(env, {
    runId,
    runDir,
    image,
    hostPort,
    token,
    names: plan.settings.env,
    gitIdentity: await gitIdentity(repo),
    ...(pathOfImage ? { imagePath: pathOfImage } : {}),
    settings: plan.record,
    ...(takeLockFrom ? { takeLockFrom } : {}),
  });
  const createArgs = [
    "--name",
    name,
    "--init",
    "--hostname",
    hostname,
    "--user",
    `${owner.uid}:${owner.gid}`,
    "--security-opt",
    "no-new-privileges",
    "--cpus",
    String(plan.settings.cpus),
    "--memory",
    `${plan.settings.memoryMb}m`,
    "--pids-limit",
    String(plan.settings.pids),
    "-v",
    `${gitTop}:${gitTop}`,
    "-v",
    `${engine}:${ENGINE_MOUNT}:ro`,
    "-w",
    opts.cwd,
    "-p",
    `127.0.0.1:${hostPort}:${SANDBOX_PORT}`,
    "--label",
    `graph-execution.run=${runId}`,
    ...vars.flatMap((v) => ["-e", v]),
    image,
    "node",
    `${ENGINE_MOUNT}/dist/cli.js`,
    ...args,
    "--web-serve",
  ];

  const fail = async (message: string, created: boolean): Promise<ExitCode> => {
    err(`error: ${message}`);
    if (created) {
      const log = await logs(name, docker).catch(() => "");
      if (log) err(log);
      await removeContainer(name, { ...docker, force: true }).catch(() => undefined);
    }
    // A new run that never got its state leaves no folder behind.
    if (!resuming && !existsSync(path.join(runDir, "state.json"))) await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    return EXIT_ABORT;
  };

  try {
    await create(createArgs, docker);
  } catch (e) {
    return fail(`cannot create the sandbox: ${e instanceof Error ? e.message : String(e)}`, false);
  }
  try {
    const staged = await stageLogins(logins);
    try {
      await cp(`${staged}/.`, name, SANDBOX_HOME, { ...docker, archive: true });
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
    await start(name, docker);
  } catch (e) {
    return fail(`cannot start the sandbox: ${e instanceof Error ? e.message : String(e)}`, true);
  }

  const timeoutMs = deps.readyTimeoutMs ?? 60_000;
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(readyFile)) break;
    const state = await inspect(name, docker).catch(() => undefined);
    if (state && !state.running) return fail(`the sandbox exited (exit code ${state.exitCode}) before the run's page was up`, true);
    if (Date.now() >= end) return fail(`the run's page did not come up within ${Math.round(timeoutMs / 1000)} s`, true);
    await sleep(200);
  }

  const record: SandboxRecord = { container: name, image, hostname, url: `http://127.0.0.1:${hostPort}/`, token, host: os.hostname() };
  await writeFile(path.join(runDir, SANDBOX_FILE), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await chmod(path.join(runDir, SANDBOX_FILE), 0o600);
  const url = sandboxPageUrl(record);
  out(`Run ${runId} started in a sandbox: ${url}`);
  const ssh = Boolean(env.SSH_CONNECTION || env.SSH_TTY);
  if (ssh) {
    out(`From your machine: ssh -L ${hostPort}:127.0.0.1:${hostPort} ${os.hostname()}, then open ${url}`);
  } else {
    await (deps.open ?? openInBrowser)(url).catch(() => false);
  }
  return EXIT_SUCCESS;
}
