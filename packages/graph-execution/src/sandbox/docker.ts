// A thin wrapper around the `docker` CLI (not the socket API: the CLI handles contexts, Docker Desktop and remote
// daemons). Every function takes an injectable `exec` for unit tests.
import { execa } from "execa";
import { findOnPath } from "../providers/index.js";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Written to stdin. */
  input?: string;
  /** Each output line (stdout and stderr) as it comes. */
  onLine?: (line: string) => void;
}

/** Runs `docker <args>` and resolves with its result; never rejects for a non-zero exit. */
export type Exec = (args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export interface DockerOptions {
  exec?: Exec;
  /** Where `docker` is looked up from (relative PATH entries). */
  cwd?: string;
}

export const DOCKER_MISSING = "--sandbox needs Docker: the docker command was not found or cannot reach a daemon";

export class DockerError extends Error {
  readonly stderr: string;
  constructor(args: string[], result: ExecResult) {
    const detail = (result.stderr || result.stdout).trim();
    super(`docker ${args.slice(0, 2).join(" ")} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`);
    this.name = "DockerError";
    this.stderr = result.stderr;
  }
}

/** The `docker` binary on the PATH, or undefined. */
export function dockerBin(cwd = process.cwd()): string | undefined {
  return findOnPath("docker", cwd);
}

/** The real exec: the `docker` found on the PATH, through execa. */
export function defaultExec(cwd = process.cwd()): Exec {
  return async (args, opts = {}) => {
    const bin = dockerBin(cwd);
    if (!bin) return { exitCode: 127, stdout: "", stderr: "docker: command not found" };
    const child = execa(bin, args, { cwd, reject: false, input: opts.input ?? "", stripFinalNewline: true });
    if (opts.onLine) {
      const onLine = opts.onLine;
      for (const stream of [child.stdout, child.stderr]) {
        let buf = "";
        stream?.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          const parts = buf.split(/\r?\n/);
          buf = parts.pop() ?? "";
          for (const p of parts) onLine(p);
        });
        stream?.on("end", () => {
          if (buf !== "") onLine(buf);
          buf = "";
        });
      }
    }
    const r = await child;
    const text = (v: unknown): string => (typeof v === "string" ? v : "");
    return { exitCode: r.exitCode ?? (r.failed ? 1 : 0), stdout: text(r.stdout), stderr: text(r.stderr) };
  };
}

const execOf = (o: DockerOptions = {}): Exec => o.exec ?? defaultExec(o.cwd);

/** Runs and throws a DockerError on a non-zero exit. */
async function run(args: string[], o: DockerOptions & ExecOptions = {}): Promise<string> {
  const r = await execOf(o)(args, { ...(o.input !== undefined ? { input: o.input } : {}), ...(o.onLine ? { onLine: o.onLine } : {}) });
  if (r.exitCode !== 0) throw new DockerError(args, r);
  return r.stdout;
}

/** True when `docker` is on the PATH and reaches a daemon (`docker version`). */
export async function dockerAvailable(o: DockerOptions = {}): Promise<boolean> {
  if (!o.exec && !dockerBin(o.cwd)) return false;
  try {
    const r = await execOf(o)(["version", "--format", "{{.Server.Version}}"]);
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/** True when the image is present locally. */
export async function imageExists(tag: string, o: DockerOptions = {}): Promise<boolean> {
  const r = await execOf(o)(["image", "inspect", "--format", "{{.Id}}", tag]);
  return r.exitCode === 0;
}

/** `docker pull <image>`. */
export async function pull(image: string, o: DockerOptions & { onLine?: (l: string) => void } = {}): Promise<void> {
  await run(["pull", image], o);
}

/** `docker build -t <tag> [--no-cache --pull] -` with the Dockerfile on stdin and no build context. */
export async function build(
  dockerfile: string,
  tag: string,
  o: DockerOptions & { noCache?: boolean; onLine?: (l: string) => void } = {},
): Promise<void> {
  const args = ["build", "-t", tag, ...(o.noCache ? ["--no-cache", "--pull"] : []), "-"];
  await run(args, { ...o, input: dockerfile });
}

/** The image's own `PATH` (from its config env), or undefined. */
export async function imagePath(image: string, o: DockerOptions = {}): Promise<string | undefined> {
  const out = await run(["image", "inspect", "--format", "{{json .Config.Env}}", image], o);
  let env: unknown;
  try {
    env = JSON.parse(out.trim());
  } catch {
    return undefined;
  }
  if (!Array.isArray(env)) return undefined;
  const entry = env.find((e): e is string => typeof e === "string" && e.startsWith("PATH="));
  return entry?.slice("PATH=".length);
}

/** `docker create <args>`; resolves with the container id. */
export async function create(args: string[], o: DockerOptions = {}): Promise<string> {
  return (await run(["create", ...args], o)).trim();
}

/** `docker cp [-a] <src> <ctr>:<dest>`. */
export async function cp(src: string, ctr: string, dest: string, o: DockerOptions & { archive?: boolean } = {}): Promise<void> {
  await run(["cp", ...(o.archive ? ["-a"] : []), src, `${ctr}:${dest}`], o);
}

/** `docker start <name>`. */
export async function start(name: string, o: DockerOptions = {}): Promise<void> {
  await run(["start", name], o);
}

export interface ContainerState {
  status: string;
  running: boolean;
  exitCode: number;
}

/** The container's state, or undefined when there is no such container. */
export async function inspect(name: string, o: DockerOptions = {}): Promise<ContainerState | undefined> {
  const args = ["container", "inspect", "--format", "{{json .State}}", name];
  const r = await execOf(o)(args);
  if (r.exitCode !== 0) {
    if (/no such (container|object)/i.test(r.stderr)) return undefined;
    throw new DockerError(args, r);
  }
  const s = JSON.parse(r.stdout.trim()) as { Status?: string; Running?: boolean; ExitCode?: number };
  return { status: s.Status ?? "unknown", running: s.Running === true, exitCode: s.ExitCode ?? 0 };
}

/** The host port published for `containerPort` (e.g. `7600/tcp`), or undefined. */
export async function port(name: string, containerPort: string, o: DockerOptions = {}): Promise<number | undefined> {
  const out = await run(["port", name, containerPort], o);
  for (const line of out.split(/\r?\n/)) {
    const m = /:(\d+)\s*$/.exec(line.trim());
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** `docker logs <name>`: stdout and stderr together. */
export async function logs(name: string, o: DockerOptions = {}): Promise<string> {
  const args = ["logs", name];
  const r = await execOf(o)(args);
  if (r.exitCode !== 0) throw new DockerError(args, r);
  return [r.stdout, r.stderr].filter((s) => s !== "").join("\n");
}

/** `docker rm [-f] <name>`. */
export async function rm(name: string, o: DockerOptions & { force?: boolean } = {}): Promise<void> {
  await run(["rm", ...(o.force ? ["-f"] : []), name], o);
}
