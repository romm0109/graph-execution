// The server's sandbox service (KAN-88): talks to Docker, owns the `gm-sandbox` network.
// The constructor does no I/O: `buildApp` creates one for every app, tests included. Only init()/status() talk to Docker.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chown, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { REVIEWERS_ENV, RUN_REVIEWERS_FILE, RUNS_DIR } from "graph-execution/api";
import type { Config } from "./config.js";
import { type ContainerInfo, DockerClient, DockerError } from "./docker.js";
import { reviewersFilePath } from "./reviewers.js";
import type { LivePage } from "./runs.js";
import { containerBody, gitIdentity, loginEntries, SandboxError, sandboxEnv, workspaceMount } from "./sandbox-run.js";
import { engineDirOf, fillTools, TOOLS_TARGET } from "./sandbox-tools.js";
import type { DataStore, SandboxRecord } from "./store.js";
import { tarArchive } from "./tar.js";
import { resolveWorkspace, type Workspace } from "./workspaces.js";

/** The bridge network of graph-manager and its sandbox containers. */
export const SANDBOX_NETWORK = "gm-sandbox";
/** The port of the run page inside a sandbox container. */
export const SANDBOX_PORT = 7600;
const DEFAULT_SOCKET = "/var/run/docker.sock";
/** The image of a sandbox when nothing else names one: Node for the engine, plus git (the full bookworm image has it). */
export const DEFAULT_SANDBOX_IMAGE = "node:24.22.1-bookworm";
/** How long an "unavailable" status is kept before status() checks again. */
const RETRY_MS = 10_000;

export interface SandboxStatus {
  available: boolean;
  reason?: string;
  defaultImage?: string;
}

/** The read-only mount of the tools folder in a sandbox container. */
export interface ToolsMount {
  Type: "bind" | "volume";
  Source: string;
  Target: string;
  ReadOnly: true;
}

/** graph-manager's version (apps/graph-manager/package.json; the same relative path from src/server and dist/server). */
const GM_VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

export interface StartParams {
  ws: Workspace;
  cwd: string;
  /** Engine arguments without `--web`. */
  args: string[];
  runId: string;
  /** The providers whose login files are copied in. */
  providers: string[];
  /** The container hostname of a previous sandbox of this run, whose lock the engine may take over. */
  takeLockFrom?: string;
  image?: string;
  readyTimeoutMs?: number;
}

/** A sandboxed run's page as the proxy and view cache see it. */
export type SandboxPage = LivePage & { upstream: { host: string; port: number; hostPort?: number; token?: string } };

const READY_POLL_MS = 250;

/**
 * The copy of graph-manager's reviewers file (KAN-87) in a sandboxed run's folder: `<dataDir>` is never mounted, and
 * the workspace is, at the same path. The engine copies it to `reviewers.json` at start, as for any reviewers file.
 */
export const SANDBOX_REVIEWERS_FILE = ".sandbox-reviewers.json";

/** The file's text and the providers its enabled reviewers name, or undefined when it can't be read. */
async function readReviewers(file: string): Promise<{ text: Buffer; providers: string[] } | undefined> {
  let text: Buffer;
  try {
    text = await readFile(file);
  } catch {
    return undefined;
  }
  const providers: string[] = [];
  try {
    const parsed = JSON.parse(text.toString("utf8")) as { reviewers?: { enabled?: boolean; provider?: unknown }[] };
    for (const r of parsed.reviewers ?? []) if (r.enabled !== false && typeof r.provider === "string") providers.push(r.provider);
  } catch {
    // the engine reports an invalid file at startup
  }
  return { text, providers };
}
const INSPECT_CACHE_MS = 1000;
const recordKey = (wsId: string, runId: string): string => `${wsId}/${runId}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Sandboxes {
  readonly docker: DockerClient;
  /** graph-manager's own container, when it runs in Docker (after init). */
  self?: ContainerInfo;
  private last?: { status: SandboxStatus; at: number };
  private pending?: Promise<SandboxStatus>;
  private mount?: ToolsMount;
  /** Container ids with a running watcher. */
  private readonly watched = new Set<string>();
  /** Container ids whose start() still waits for the ready file: no watcher or reconcile removes them. */
  private readonly starting = new Set<string>();
  private readonly inspected = new Map<string, { at: number; info: Promise<ContainerInfo | undefined> }>();
  /** How long start() waits for the ready file (tests lower it). */
  readyTimeoutMs = 60_000;

  /** `pathEnv`: where the provider CLIs are looked up (default `process.env.PATH`). */
  constructor(readonly opts: { config: Config; store: DataStore; docker?: DockerClient; pathEnv?: string }) {
    this.docker = opts.docker ?? new DockerClient(opts.config.dockerSocket ?? DEFAULT_SOCKET);
  }

  /** Pings Docker, inspects itself, ensures the gm-sandbox network (and joins it in Docker). Never throws: failures become `status().reason`. */
  init(): Promise<SandboxStatus> {
    if (!this.pending) {
      this.pending = this.doInit()
        .catch((err: unknown): SandboxStatus => ({ available: false, reason: messageOf(err) }))
        .then((status) => {
          this.last = { status, at: Date.now() };
          return status;
        })
        .finally(() => {
          this.pending = undefined;
        });
    }
    return this.pending;
  }

  /** The cached status; re-runs init when it is unavailable and the last check is older than 10 s, or when never run. */
  async status(): Promise<SandboxStatus> {
    if (this.pending) return this.pending;
    const last = this.last;
    if (!last || (!last.status.available && Date.now() - last.at > RETRY_MS)) return this.init();
    return last.status;
  }

  /** The default image: config.sandboxImage, else graph-manager's own image when it runs in Docker, else DEFAULT_SANDBOX_IMAGE. */
  defaultImage(): string {
    return this.opts.config.sandboxImage ?? this.self?.Config.Image ?? DEFAULT_SANDBOX_IMAGE;
  }

  /** The tools folder graph-manager fills: config.sandboxToolsDir, else /opt/gm-tools in Docker, else <dataDir>/sandbox-tools. */
  toolsDir(): string {
    const { config } = this.opts;
    return config.sandboxToolsDir ?? (this.self ? TOOLS_TARGET : path.join(config.dataDir, "sandbox-tools"));
  }

  /** The read-only mount of the tools folder for sandbox containers; set by a successful init. */
  toolsMount(): ToolsMount | undefined {
    return this.mount;
  }

  /** The stored sandbox record of a run, if any. */
  recordOf(wsId: string, runId: string): SandboxRecord | undefined {
    return this.opts.store.get().sandboxes[recordKey(wsId, runId)];
  }

  /**
   * Starts a run in its own container: creates it, copies the provider logins in, starts it, saves the record and
   * waits for the engine's ready file. Throws a `SandboxError` (and leaves no container) when that fails.
   */
  async start(p: StartParams): Promise<SandboxRecord> {
    const { docker } = this;
    const { store, config } = this.opts;
    const st = await this.status();
    if (!st.available) throw new SandboxError(400, st.reason ?? "sandboxes are not available");
    const image = p.image || store.get().workspaceSettings[p.ws.id]?.image || this.defaultImage();
    if (!(await docker.imageExists(image).catch(() => true))) {
      try {
        await docker.pullImage(image);
      } catch (err) {
        throw new SandboxError(400, `cannot pull the sandbox image ${image}: ${messageOf(err)}`);
      }
    }
    const tools = this.toolsMount();
    if (!tools) throw new SandboxError(400, "the sandbox tools are not ready");

    const runDir = path.join(p.ws.path, RUNS_DIR, p.runId);
    const readyFile = path.join(runDir, ".ready.json");
    await rm(readyFile, { force: true });
    const st2 = await stat(p.ws.path);
    const owner = { uid: st2.uid, gid: st2.gid };
    const host = `sbx-${randomBytes(4).toString("hex")}`;
    const token = randomBytes(24).toString("base64url");
    const name = `gm-run-${p.runId}`;

    const old = await docker.inspectContainer(name);
    if (old) {
      if (old.State.Running) throw new SandboxError(409, "the run's sandbox is still running");
      await docker.removeContainer(old.Id);
    }

    // Reviewers (KAN-87): a new run gets graph-manager's file copied into the home; a resume reads the run's own copy.
    const resuming = p.args.includes("--resume");
    const reviewers = await readReviewers(resuming ? path.join(runDir, RUN_REVIEWERS_FILE) : reviewersFilePath(config.dataDir));
    const providers = [...new Set([...p.providers, ...(reviewers?.providers ?? [])])];
    let reviewersCopy: string | undefined;
    if (!resuming && reviewers) {
      reviewersCopy = path.join(runDir, SANDBOX_REVIEWERS_FILE);
      const made = await mkdir(runDir, { recursive: true });
      // Folders graph-manager makes belong to the workspace owner, as if the engine had made them.
      if (made) for (let d = runDir; d.length >= made.length; d = path.dirname(d)) await chown(d, owner.uid, owner.gid).catch(() => undefined);
      await writeFile(reviewersCopy, reviewers.text, { mode: 0o600 });
      await chown(reviewersCopy, owner.uid, owner.gid).catch(() => undefined);
    }

    const env = sandboxEnv(process.env, {
      runId: p.runId,
      runDir,
      image,
      token,
      ...(p.takeLockFrom ? { takeLockFrom: p.takeLockFrom } : {}),
      gitIdentity: await gitIdentity(p.ws.path),
    }).filter((e) => !e.startsWith(`${REVIEWERS_ENV}=`));
    if (reviewersCopy) env.push(`${REVIEWERS_ENV}=${reviewersCopy}`);
    const mounts = [workspaceMount(p.ws, config.workspacesDir, this.self, config.sandboxWorkspacesSource), tools];
    const body = containerBody({
      image,
      hostname: host,
      owner,
      env,
      args: p.args,
      cwd: p.cwd,
      runId: p.runId,
      workspaceId: p.ws.id,
      limits: store.get().sandboxLimits,
      mounts,
      // In Docker, graph-manager reaches the container on gm-sandbox; on the host, only through a published port.
      ...(this.self ? {} : { publishPort: SANDBOX_PORT }),
    });
    let id: string;
    try {
      id = await docker.createContainer(name, body);
    } catch (err) {
      throw new SandboxError(400, `cannot create the sandbox: ${messageOf(err)}`);
    }

    const key = recordKey(p.ws.id, p.runId);
    let rec: SandboxRecord | undefined;
    const discard = async (): Promise<void> => {
      await docker.removeContainer(id).catch(() => undefined);
      if (rec) await this.dropRecord(key, id).catch(() => undefined);
    };
    try {
      await docker.putArchive(id, "/", tarArchive(await loginEntries(providers, os.homedir(), process.env), owner));
      await docker.startContainer(id);
      rec = { runId: p.runId, workspace: p.ws.id, container: id, name, host, image, port: SANDBOX_PORT, token, startedAt: new Date().toISOString() };
      const saved = rec;
      await store.update((d) => {
        d.sandboxes[key] = saved;
      });
    } catch (err) {
      await discard();
      if (err instanceof SandboxError) throw err;
      throw new SandboxError(400, `cannot start the sandbox: ${messageOf(err)}`);
    }

    const timeoutMs = p.readyTimeoutMs ?? this.readyTimeoutMs;
    const end = Date.now() + timeoutMs;
    // The watcher starts only once the ready file is there: until then a container that exits must stay, so its
    // exit code and log can go into the error.
    this.starting.add(id);
    try {
      for (;;) {
        if (existsSync(readyFile)) {
          this.starting.delete(id);
          this.watch(rec);
          return rec;
        }
      const info = await docker.inspectContainer(id).catch(() => undefined);
        if (!info?.State.Running) {
          const logs = await docker.containerLogs(id, 20).catch(() => "");
          await discard();
          throw new SandboxError(400, `the sandbox exited with code ${info?.State.ExitCode ?? -1}`, logs);
        }
        if (Date.now() > end) {
          const logs = await docker.containerLogs(id, 20).catch(() => "");
          await docker.stopContainer(id).catch(() => undefined);
          await discard();
          throw new SandboxError(400, "the sandbox did not start within 60 s", logs);
        }
        await sleep(READY_POLL_MS);
      }
    } finally {
      this.starting.delete(id);
    }
  }

  /**
   * Makes sure the run's previous container is gone before it is resumed in a new one: "none" without a record,
   * "removed" after removing a stopped container and dropping its record. Throws a 409 `SandboxError` while it runs.
   */
  async release(wsId: string, runId: string): Promise<"none" | "removed"> {
    const rec = this.recordOf(wsId, runId);
    if (!rec) return "none";
    const info = await this.docker.inspectContainer(rec.container);
    if (info?.State.Running) throw new SandboxError(409, "the run's sandbox is still running");
    await this.docker.removeContainer(rec.container);
    this.inspected.delete(rec.container);
    await this.dropRecord(recordKey(wsId, runId), rec.container);
    return "removed";
  }

  /** Stops the run's container (SIGTERM, SIGKILL after 10 s); false without a record. The watcher removes it. */
  async stop(wsId: string, runId: string): Promise<boolean> {
    const rec = this.recordOf(wsId, runId);
    if (!rec) return false;
    await this.docker.stopContainer(rec.container, 10);
    this.inspected.delete(rec.container);
    return true;
  }

  /** Removes the container once it exits and drops its record; once per container. */
  private watch(rec: SandboxRecord): void {
    if (this.watched.has(rec.container) || this.starting.has(rec.container)) return;
    this.watched.add(rec.container);
    const key = recordKey(rec.workspace, rec.runId);
    void this.docker
      .waitContainer(rec.container)
      .then(async () => {
        await this.docker.removeContainer(rec.container).catch(() => undefined);
        await this.dropRecord(key, rec.container);
      })
      .catch(() => undefined)
      .finally(() => {
        this.watched.delete(rec.container);
        this.inspected.delete(rec.container);
      });
  }

  /** Deletes the record `key` while it still points at `container`. */
  private async dropRecord(key: string, container: string): Promise<void> {
    if (this.opts.store.get().sandboxes[key]?.container !== container) return;
    await this.opts.store.update((d) => {
      if (d.sandboxes[key]?.container === container) delete d.sandboxes[key];
    });
  }

  /** Checks the stored records against Docker: gone or stopped containers are cleaned up, running ones watched. */
  private async reconcile(): Promise<void> {
    for (const [key, rec] of Object.entries(this.opts.store.get().sandboxes)) {
      if (this.starting.has(rec.container)) continue;
      try {
        const info = await this.docker.inspectContainer(rec.container);
        if (!info) await this.dropRecord(key, rec.container);
        else if (!info.State.Running) {
          await this.docker.removeContainer(rec.container);
          await this.dropRecord(key, rec.container);
        } else this.watch(rec);
      } catch {
        // Docker hiccup: keep the record, the next init checks again.
      }
    }
  }

  /** Inspect, cached for 1 s per container. */
  private inspectCached(id: string): Promise<ContainerInfo | undefined> {
    const hit = this.inspected.get(id);
    if (hit && Date.now() - hit.at < INSPECT_CACHE_MS) return hit.info;
    const info = this.docker.inspectContainer(id);
    this.inspected.set(id, { at: Date.now(), info });
    info.catch(() => this.inspected.delete(id));
    return info;
  }

  /**
   * The page of the sandboxed run in `runDir`: undefined when no record maps to it, null when its container is not
   * running, else the container's address on gm-sandbox.
   */
  async pageOf(runDir: string): Promise<SandboxPage | null | undefined> {
    const records = Object.values(this.opts.store.get().sandboxes);
    if (records.length === 0) return undefined;
    const dir = path.resolve(runDir);
    const rec = records.find((r) => {
      const ws = resolveWorkspace(this.opts.config.workspacesDir, r.workspace);
      return ws !== undefined && path.join(ws.path, RUNS_DIR, r.runId) === dir;
    });
    if (!rec) return undefined;
    let info: ContainerInfo | undefined;
    try {
      info = await this.inspectCached(rec.container);
    } catch {
      return null;
    }
    if (!info?.State.Running) return null;
    const page = { url: `http://127.0.0.1:${SANDBOX_PORT}/`, pid: 0 };
    const token = rec.token ? { token: rec.token } : {};
    const published = info.NetworkSettings?.Ports?.[`${rec.port}/tcp`]?.find((b) => b.HostPort);
    if (!this.self && published?.HostPort) {
      // The engine in the container still checks for `Host: 127.0.0.1:<its own port>`.
      return { ...page, upstream: { host: "127.0.0.1", port: Number(published.HostPort), hostPort: rec.port, ...token } };
    }
    const nets = info.NetworkSettings?.Networks ?? {};
    const ip = nets[SANDBOX_NETWORK]?.IPAddress || Object.values(nets).find((n) => n.IPAddress)?.IPAddress;
    if (!ip) return null;
    return { ...page, upstream: { host: ip, port: rec.port, ...token } };
  }

  /** Fills the sandbox tools; returns an error reason, or undefined when they are ready. */
  protected async prepareTools(): Promise<string | undefined> {
    const bin = this.opts.config.graphExecutionBin;
    const engineDir = engineDirOf(bin);
    if (!engineDir) return `the graph-execution engine was not found next to graph-manager (GM_GRAPH_EXECUTION_BIN=${bin})`;
    const dir = this.toolsDir();
    let mount: ToolsMount;
    if (this.self) {
      const own = this.self.Mounts?.find((m) => m.Destination === dir);
      if (!own) return `mount the gm-tools volume at ${TOOLS_TARGET} in graph-manager's container (see docker-compose.yml)`;
      mount =
        own.Type === "volume" && own.Name
          ? { Type: "volume", Source: own.Name, Target: TOOLS_TARGET, ReadOnly: true }
          : { Type: "bind", Source: own.Source, Target: TOOLS_TARGET, ReadOnly: true };
    } else {
      mount = { Type: "bind", Source: dir, Target: TOOLS_TARGET, ReadOnly: true };
    }
    try {
      await fillTools(dir, {
        engineDir,
        gmVersion: GM_VERSION,
        ...(this.opts.pathEnv !== undefined ? { pathEnv: this.opts.pathEnv } : {}),
        log: (l) => console.log(l),
      });
    } catch (err) {
      return `cannot prepare the sandbox tools: ${messageOf(err)}`;
    }
    this.mount = mount;
    return undefined;
  }

  private async doInit(): Promise<SandboxStatus> {
    const socket = this.docker.socketPath;
    try {
      await this.docker.ping();
    } catch (err) {
      // An older daemon answers "client version 1.45 is too new" (VolumeOptions.Subpath needs API 1.45).
      if (/is too new/i.test(messageOf(err))) return { available: false, reason: `Docker 26 or newer is needed (API 1.45): ${messageOf(err)}` };
      let reason = `Docker is not reachable at ${socket}: ${messageOf(err)}`;
      if (/EACCES/.test(messageOf(err))) reason += "; is graph-manager in the socket's group (DOCKER_GID)?";
      return { available: false, reason };
    }
    try {
      this.self = await this.docker.inspectSelf();
    } catch (err) {
      return { available: false, reason: `cannot inspect graph-manager's own container: ${messageOf(err)}` };
    }
    try {
      const net = await this.docker.inspectNetwork(SANDBOX_NETWORK);
      if (!net) {
        try {
          await this.docker.createNetwork(SANDBOX_NETWORK);
        } catch (err) {
          // Created by a concurrent graph-manager in between: fine.
          if (!(err instanceof DockerError && err.status === 409)) throw err;
        }
      }
      if (this.self && !this.self.NetworkSettings?.Networks?.[SANDBOX_NETWORK]) {
        await this.docker.connectNetwork(SANDBOX_NETWORK, this.self.Id);
      }
    } catch (err) {
      return { available: false, reason: `cannot set up the ${SANDBOX_NETWORK} network: ${messageOf(err)}` };
    }
    const toolsError = await this.prepareTools();
    if (toolsError !== undefined) return { available: false, reason: toolsError };
    await this.reconcile();
    return { available: true, defaultImage: this.defaultImage() };
  }
}
