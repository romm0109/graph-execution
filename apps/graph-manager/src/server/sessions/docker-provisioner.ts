// Sessions in Docker (docs/prd/hosted-sessions.md, "DockerProvisioner"): once an open-source install has two or more
// accounts, each session runs in its own container `gm-s-<sessionId>` from its owner's sandbox image, with the owner's
// own volume at /workspaces, so users cannot read each other's files from a terminal. The container runs
// `graph-manager agent` from the agent runtime volume; graph-manager reaches it only through port 7700 and a random
// token. Sandboxed runs get their own container `gm-r-<runId>` with a fresh volume and the owner's sandbox limits.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import { type ContainerInfo, DockerClient, DockerError } from "../docker.js";
import { RemoteWorkspaceHost } from "../host/remote.js";
import { HostError, type WorkspaceHost } from "../host/types.js";
import type { User } from "../identity.js";
import { SANDBOX_NETWORK, type Sandboxes } from "../sandbox.js";
import { SANDBOX_HOME, sandboxPath } from "../sandbox-run.js";
import { engineDirOf } from "../sandbox-tools.js";
import type { Store } from "../store.js";
import { tarArchive } from "../tar.js";
import {
  AGENT_TARGET,
  agentContextEntries,
  type AgentRuntime,
  ensureAgentImage,
  ensureAgentVolume,
  ensureFreshVolume,
  ensureUserVolume,
  RUN_CONTAINER_LABEL,
  USER_LABEL,
  userVolumeName,
  WORKSPACES_TARGET,
} from "./agent-image.js";
import type { SessionProvisioner } from "./provisioner.js";

export { dockerSafeId, userVolumeName, USER_LABEL, RUN_CONTAINER_LABEL, type AgentRuntime } from "./agent-image.js";

export const DOCKER_SESSIONS_DOWN =
  "Sessions need Docker when this graph-manager has more than one account. Start Docker, or set GM_SESSION_RUNTIME=local if everyone here trusts each other.";
/** The port of the workspace agent inside a session or run container. */
export const AGENT_PORT = 7700;
/** Containers run as 1000:1000, never root, never privileged, no Docker socket. */
export const SESSION_UID = 1000;
/** The label on session containers (and run containers): the session id. */
export const SESSION_LABEL = "gm.session";
const BUILDING = "the sandbox image is building; try again when it is ready";
const NOT_BUILT = "graph-manager is not built: run npm run build -w graph-manager";
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 250;
const TOKEN_ENV = "GM_AGENT_TOKEN=";

export interface DockerProvisionerOptions {
  config: Config;
  store: Store;
  sandboxes: Sandboxes;
  docker?: DockerClient;
  /** The agent runtime image and volume (tests stub it); default: built from graph-manager's dist and the engine. */
  agentRuntime?: () => Promise<AgentRuntime>;
  /** Default: poll GET <url>/agent/v1/healthz every 250 ms for 60 s, checking the container still runs. */
  waitReady?: (url: string, containerId: string) => Promise<void>;
  /** Default: `new RemoteWorkspaceHost(url, token)`. */
  hostOf?: (url: string, token: string) => WorkspaceHost;
  /** The folder of graph-manager's built server (default: the folder of this module's parent, dist/server). */
  serverDir?: string;
}

const sessionName = (sessionId: string): string => `gm-s-${sessionId}`;
const runName = (runId: string): string => `gm-r-${runId}`;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** No such container, or no Docker at all (then there is nothing running to remove either). */
const isGone = (err: unknown): boolean => err instanceof DockerError && (err.status === 404 || err.status === 0);

/** A container that stopped while graph-manager waited for its agent. */
class ExitedError extends Error {
  constructor(readonly code: number) {
    super(`exited with code ${code}`);
  }
}

/** A container whose agent did not answer within 60 s. */
class TimeoutError extends Error {}

/** What one container gets: its name, labels, volume and (run containers) limits. */
interface Spec {
  user: User;
  sessionId: string;
  name: string;
  labels: Record<string, string>;
  volume: (runtime: AgentRuntime) => Promise<string>;
  limits?: { cpus: number; memoryMb: number; pids: number };
  what: "session" | "run";
}

export class DockerProvisioner implements SessionProvisioner {
  readonly docker: DockerClient;
  private readonly inflight = new Map<string, Promise<WorkspaceHost>>();
  private runtime?: Promise<AgentRuntime>;

  constructor(private readonly opts: DockerProvisionerOptions) {
    this.docker = opts.docker ?? opts.sandboxes.docker;
  }

  acquire({ user, sessionId }: { user: User; sessionId: string }): Promise<WorkspaceHost> {
    return this.once(sessionName(sessionId), () =>
      this.start({
        user,
        sessionId,
        name: sessionName(sessionId),
        labels: { [SESSION_LABEL]: sessionId, [USER_LABEL]: user.id },
        volume: (rt) => ensureUserVolume(this.docker, rt.imageTag, user),
        what: "session",
      }),
    );
  }

  async release({ sessionId }: { user?: User; sessionId: string }): Promise<void> {
    await this.remove(sessionName(sessionId));
  }

  acquireRun({ user, sessionId, runId }: { user: User; sessionId: string; runId: string }): Promise<WorkspaceHost> {
    return this.once(runName(runId), async () => {
      const limits = (await this.opts.store.forUser(user)).get().sandboxLimits;
      return this.start({
        user,
        sessionId,
        name: runName(runId),
        labels: { [RUN_CONTAINER_LABEL]: runId, [SESSION_LABEL]: sessionId, [USER_LABEL]: user.id },
        volume: (rt) => ensureFreshVolume(this.docker, runName(runId), rt.imageTag, { [RUN_CONTAINER_LABEL]: runId }),
        limits,
        what: "run",
      });
    });
  }

  async releaseRun({ runId }: { user?: User; runId: string }): Promise<void> {
    await this.remove(runName(runId));
    await this.docker.removeVolume(runName(runId)).catch((err: unknown) => {
      if (!isGone(err)) throw err;
    });
  }

  /**
   * Removes every container of the user (sessions and runs): a disabled or deleted user's containers stop at once.
   * Their volume is kept (a disabled user may come back). Docker not being reachable is fine: there is nothing to remove.
   */
  async releaseUser(userId: string): Promise<void> {
    let list;
    try {
      list = await this.docker.listContainers(USER_LABEL);
    } catch (err) {
      if (isGone(err)) return;
      throw err;
    }
    for (const c of list) if (c.Labels[USER_LABEL] === userId) await this.remove(c.Id);
  }

  /** A deleted user: their containers, then their workspaces volume. */
  async deleteUser(userId: string): Promise<void> {
    await this.releaseUser(userId);
    await this.docker.removeVolume(userVolumeName(userId)).catch((err: unknown) => {
      if (!isGone(err)) throw err;
    });
  }

  // ---- internals ----

  private async remove(nameOrId: string): Promise<void> {
    try {
      await this.docker.removeContainer(nameOrId, { force: true });
    } catch (err) {
      if (!isGone(err)) throw err;
    }
  }

  /** One start per container name at a time: a second caller waits for the first one's host. */
  private once(name: string, fn: () => Promise<WorkspaceHost>): Promise<WorkspaceHost> {
    const running = this.inflight.get(name);
    if (running) return running;
    const p = fn().finally(() => this.inflight.delete(name));
    this.inflight.set(name, p);
    return p;
  }

  /** The agent runtime: the injected one, else built once (and again when its image or volume went missing). */
  private async agentRuntime(): Promise<AgentRuntime> {
    if (this.opts.agentRuntime) return this.opts.agentRuntime();
    if (this.runtime) {
      const rt = await this.runtime.catch(() => undefined);
      if (rt && (await this.docker.inspectImage(rt.imageTag)) && (await this.docker.inspectVolume(rt.volume))) return rt;
      this.runtime = undefined;
    }
    this.runtime ??= this.buildRuntime();
    try {
      return await this.runtime;
    } catch (err) {
      this.runtime = undefined;
      throw err;
    }
  }

  private async buildRuntime(): Promise<AgentRuntime> {
    const serverDir = this.opts.serverDir ?? fileURLToPath(new URL("../", import.meta.url));
    if (!existsSync(`${serverDir}/cli.js`)) throw new HostError(503, NOT_BUILT);
    const engineDir = engineDirOf(this.opts.config.graphExecutionBin);
    if (!engineDir) {
      throw new HostError(503, `the graph-execution engine was not found next to graph-manager (GM_GRAPH_EXECUTION_BIN=${this.opts.config.graphExecutionBin})`);
    }
    const instance = this.opts.sandboxes.instanceId();
    const image = await ensureAgentImage(this.docker, await agentContextEntries(serverDir, engineDir), instance);
    return { imageTag: image.tag, volume: await ensureAgentVolume(this.docker, image, instance) };
  }

  /** Docker answers, the sandbox images are ready, and the owner's image for this session exists: its tag. */
  private async imageOf(user: User, sessionId: string): Promise<string> {
    try {
      await this.docker.ping();
    } catch {
      throw new HostError(503, DOCKER_SESSIONS_DOWN);
    }
    const { sandboxes } = this.opts;
    const st = await sandboxes.status();
    if (st.building) throw new HostError(409, BUILDING);
    if (!st.available) throw new HostError(503, st.reason ?? "sandboxes are not available");
    const data = (await this.opts.store.forUser(user)).get();
    const rec = Object.hasOwn(data.sessions, sessionId) ? data.sessions[sessionId] : undefined;
    const sel = sandboxes.imageForData(data, rec?.workspaceId ?? "");
    const exists = await this.docker.imageExists(sel.image).catch(() => true);
    if (!exists && sel.recipe) {
      // The owner's own recipe image: built here, never pulled.
      sandboxes.queueRecipeBuild(sel.recipe);
      throw new HostError(409, BUILDING);
    }
    if (!exists) {
      try {
        await this.docker.pullImage(sel.image);
      } catch (err) {
        throw new HostError(400, `cannot pull the sandbox image ${sel.image}: ${messageOf(err)}`);
      }
    }
    return sel.image;
  }

  /** Where graph-manager reaches the agent of a running container (mirrors Sandboxes.pageOf). */
  private urlOf(info: ContainerInfo): string {
    const published = info.NetworkSettings?.Ports?.[`${AGENT_PORT}/tcp`]?.find((b) => b.HostPort);
    if (!this.opts.sandboxes.self && published?.HostPort) return `http://127.0.0.1:${published.HostPort}`;
    const nets = info.NetworkSettings?.Networks ?? {};
    const ip = nets[SANDBOX_NETWORK]?.IPAddress || Object.values(nets).find((n) => n.IPAddress)?.IPAddress;
    if (!ip) throw new HostError(502, "the session container has no address");
    return `http://${ip}:${AGENT_PORT}`;
  }

  private hostOf(url: string, token: string): WorkspaceHost {
    return this.opts.hostOf ? this.opts.hostOf(url, token) : new RemoteWorkspaceHost(url, token);
  }

  private async waitReady(url: string, id: string): Promise<void> {
    if (this.opts.waitReady) return this.opts.waitReady(url, id);
    const end = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const ok = await fetch(`${url}/agent/v1/healthz`, { signal: AbortSignal.timeout(2000) })
        .then(async (res) => {
          await res.body?.cancel().catch(() => undefined);
          return res.ok;
        })
        .catch(() => false);
      if (ok) return;
      const info = await this.docker.inspectContainer(id).catch(() => undefined);
      if (!info?.State.Running) throw new ExitedError(info?.State.ExitCode ?? -1);
      if (Date.now() > end) throw new TimeoutError();
      await sleep(READY_POLL_MS);
    }
  }

  /** Creates and starts the container of `spec` (or re-attaches to a running one) and waits for its agent. */
  private async start(spec: Spec): Promise<WorkspaceHost> {
    const image = await this.imageOf(spec.user, spec.sessionId);
    const { sandboxes } = this.opts;
    const tools = sandboxes.toolsMount();
    const clis = sandboxes.clisMount();
    if (!tools || !clis) throw new HostError(409, BUILDING);
    const runtime = await this.agentRuntime();
    const volume = await spec.volume(runtime);

    const old = await this.docker.inspectContainer(spec.name);
    if (old?.State.Running) {
      // A live container (graph-manager restarted, or a second acquire): re-attach with its own token.
      const token = old.Config.Env?.find((e) => e.startsWith(TOKEN_ENV))?.slice(TOKEN_ENV.length);
      if (token) {
        const url = this.urlOf(old);
        await this.ready(spec, url, old.Id);
        return this.hostOf(url, token);
      }
    }
    if (old) await this.remove(old.Id);

    const imagePath = (await this.docker.inspectImage(image).catch(() => undefined))?.Config?.Env?.find((e) => e.startsWith("PATH="))?.slice(5);
    const token = randomBytes(32).toString("hex");
    const inDocker = !!sandboxes.self;
    const env = [
      `${TOKEN_ENV}${token}`,
      `HOME=${SANDBOX_HOME}`,
      `PATH=${AGENT_TARGET}/bin:${sandboxPath(imagePath)}`,
      "GM_GRAPH_EXECUTION_BIN=/opt/gm-tools/graph-execution/dist/cli.js",
      ...["TZ", "LANG"].flatMap((k) => (process.env[k] ? [`${k}=${process.env[k]}`] : [])),
    ];
    const port = `${AGENT_PORT}/tcp`;
    const body = {
      Image: image,
      Hostname: spec.name.slice(0, 63),
      User: `${SESSION_UID}:${SESSION_UID}`,
      Env: env,
      Cmd: ["graph-manager", "agent", "--port", String(AGENT_PORT), "--workspaces", WORKSPACES_TARGET],
      WorkingDir: WORKSPACES_TARGET,
      Labels: spec.labels,
      ...(inDocker ? {} : { ExposedPorts: { [port]: {} } }),
      HostConfig: {
        Init: true,
        Privileged: false,
        SecurityOpt: ["no-new-privileges"],
        NetworkMode: SANDBOX_NETWORK,
        ...(spec.limits
          ? {
              NanoCpus: Math.round(spec.limits.cpus * 1e9),
              Memory: spec.limits.memoryMb * 1024 * 1024,
              PidsLimit: spec.limits.pids,
            }
          : {}),
        Mounts: [
          { Type: "volume", Source: volume, Target: WORKSPACES_TARGET },
          tools,
          clis,
          { Type: "volume", Source: runtime.volume, Target: AGENT_TARGET, ReadOnly: true },
        ],
        ...(inDocker ? {} : { PortBindings: { [port]: [{ HostIp: "127.0.0.1", HostPort: "" }] } }),
      },
    };
    let id: string;
    try {
      id = await this.docker.createContainer(spec.name, body);
    } catch (err) {
      throw new HostError(502, `cannot create the ${spec.what} container: ${messageOf(err)}`);
    }
    let url: string;
    try {
      // HOME must exist and be writable by the session user; the logins arrive later through the agent.
      await this.docker.putArchive(id, "/", tarArchive([{ path: "home/sandbox/", dir: true, mode: 0o700 }], { uid: SESSION_UID, gid: SESSION_UID }));
      await this.docker.startContainer(id);
      const info = await this.docker.inspectContainer(id);
      if (!info) throw new HostError(502, `the ${spec.what} container is gone`);
      url = this.urlOf(info);
    } catch (err) {
      await this.remove(id).catch(() => undefined);
      if (err instanceof HostError) throw err;
      throw new HostError(502, `cannot start the ${spec.what} container: ${messageOf(err)}`);
    }
    await this.ready(spec, url, id);
    return this.hostOf(url, token);
  }

  /** Waits for the agent; on failure removes the container and answers 502 with its last log lines. */
  private async ready(spec: Spec, url: string, id: string): Promise<void> {
    try {
      await this.waitReady(url, id);
    } catch (err) {
      const logs = (await this.docker.containerLogs(id, 20).catch(() => "")).trim();
      await this.remove(id).catch(() => undefined);
      let msg: string;
      if (err instanceof ExitedError) msg = `the ${spec.what} container exited with code ${err.code}`;
      else if (err instanceof TimeoutError) msg = `the ${spec.what} container did not start within 60 s`;
      else msg = `the ${spec.what} container did not start: ${messageOf(err)}`;
      throw new HostError(502, logs ? `${msg}\n${logs}` : msg);
    }
  }
}
