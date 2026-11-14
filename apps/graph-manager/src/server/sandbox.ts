// The server's sandbox service (KAN-88): talks to Docker, owns the `gm-sandbox` network.
// The constructor does no I/O: `buildApp` creates one for every app, tests included. Only init()/status() talk to Docker.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chown, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { REVIEWERS_ENV, RUN_REVIEWERS_FILE, RUNS_DIR } from "graph-execution/api";
import type { Config } from "./config.js";
import { type ContainerInfo, DockerClient, DockerError } from "./docker.js";
import { reviewersFilePath } from "./reviewers.js";
import type { LivePage } from "./runs.js";
import { toContainer, toContainerArgs } from "./sandbox-paths.js";
import { containerBody, gitIdentity, loginEntries, repoMounts, SandboxError, sandboxEnv, windowsGitConfig, workspaceMount } from "./sandbox-run.js";
import {
  CLIS_LABEL,
  CLIS_TARGET,
  cliImageTag,
  DEFAULT_RECIPE,
  defaultRecipe,
  ensureCliImage,
  ensureClisVolume,
  INSTANCE_LABEL,
  ensureSandboxImage,
  removeOldImages,
  SANDBOX_IMAGE_REPO,
  type SandboxRecipe,
  sandboxDockerfile,
  sandboxImageTag,
} from "./sandbox-image.js";
import { engineDirOf, fillTools, TOOLS_TARGET } from "./sandbox-tools.js";
import { gmVersion } from "./version.js";
import type { Data, SandboxRecord, UserStore } from "./store.js";
import { tarArchive } from "./tar.js";
import { resolveRunHome } from "./runhome.js";
import type { Workspace } from "./workspaces.js";

/** The bridge network of graph-manager and its sandbox containers. */
export const SANDBOX_NETWORK = "gm-sandbox";
/** The port of the run page inside a sandbox container. */
export const SANDBOX_PORT = 7600;
const DEFAULT_SOCKET = "/var/run/docker.sock";
/** The base image of the default recipe: Node for the engine, plus git (the full bookworm image has it). */
export const DEFAULT_SANDBOX_IMAGE = DEFAULT_RECIPE.base;
/** How long an "unavailable" status is kept before status() checks again. */
const RETRY_MS = 10_000;
/** How long init() waits for the image build before it answers "building". */
const INIT_WAIT_MS = 500;
/** The build log lines kept. */
const BUILD_LOG_LINES = 1000;
const BUILDING_REASON = "building the sandbox image";
const BUILDING_START = "the sandbox image is building; try again when it is ready";
/** The answer to a start (or a recipe save) while a workspace's own image is queued or built. */
export const WS_BUILDING_START = "the sandbox image of this workspace is building; try again when it is ready";

/** Where a workspace's sandbox image comes from: the global recipe, its own recipe or a ready-made image. */
export type ImageSource = "global" | "recipe" | "image";

export interface SandboxStatus {
  available: boolean;
  /** True while the sandbox images are built (then `available` is false). */
  building?: boolean;
  /** While building: true when the tools and the gm-clis volume are ready, so a workspace with its own image can start. */
  clisReady?: boolean;
  reason?: string;
  defaultImage?: string;
}

/** The state of the sandbox image build. */
export interface SandboxBuild {
  /** `queued`: waiting for another build to finish (one build runs at a time). */
  state: "idle" | "queued" | "building" | "ready" | "failed";
  step?: "clis" | "image";
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  log: string[];
}

const failedStatus = (error: string | undefined): SandboxStatus => ({
  available: false,
  building: false,
  reason: `the sandbox image build failed: ${error}`,
});

/** The read-only mount of the tools folder in a sandbox container. */
export interface ToolsMount {
  Type: "bind" | "volume";
  Source: string;
  Target: string;
  ReadOnly: true;
}

/** graph-manager's version (apps/graph-manager/package.json, or dist/manager/package.json when bundled into graph-execution). */
const GM_VERSION = gmVersion();

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
  /**
   * A project run (`ws` is the project folder, `homeAsWorkspace`): every repo of the project, mounted at its own path
   * too. `link`: the repo's path in project.json (`repos/<name>`).
   */
  repos?: { link: string; workspace: Workspace }[];
  /** Variables of the requesting user (their saved agent keys) added to graph-manager's env for this sandbox. */
  extraEnv?: Record<string, string>;
  /** The store of the user the run belongs to: its image settings and limits apply and its record is saved there. Default: the instance's store. */
  store?: UserStore;
  /** That user's reviewers file (`<dataDir>/reviewers/<user>.json`); default `<dataDir>/reviewers.json`. */
  reviewersFile?: string;
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

/** Appends a build log line, keeping the last BUILD_LOG_LINES. */
function pushLine(build: SandboxBuild, l: string): void {
  build.log.push(l);
  if (build.log.length > BUILD_LOG_LINES) build.log.splice(0, build.log.length - BUILD_LOG_LINES);
}

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
  private build: SandboxBuild = { state: "idle", log: [] };
  /** The running image build, if any. */
  private building?: Promise<void>;
  /** True while init() copies the engine into the tools folder: the build starts after it, so status() answers "building". */
  private preparing = false;
  /** A Rebuild asked for while init() was still preparing: the build init() starts is forced. */
  private forceNext?: { force: boolean; clis: boolean };
  /** The gm-clis volume of the current CLIs image (after a successful build). */
  private clisVolume?: string;
  /** The built default image (after a successful build). */
  private image?: string;
  /** The build state of each workspace's own recipe image. */
  private readonly wsBuilds = new Map<string, SandboxBuild>();
  /** The chain every image build runs on: one build at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The builds in the chain, running or waiting. */
  private queued = 0;
  /** Container ids with a running watcher. */
  private readonly watched = new Set<string>();
  /** Container ids whose start() still waits for the ready file: no watcher or reconcile removes them. */
  private readonly starting = new Set<string>();
  private readonly inspected = new Map<string, { at: number; info: Promise<ContainerInfo | undefined> }>();
  /** How long start() waits for the ready file (tests lower it). */
  readyTimeoutMs = 60_000;

  /**
   * The host platform (default `process.platform`): decides the Docker Desktop hint, whether graph-manager can be in a
   * container itself, and how workspace paths are mapped. Tests set it.
   */
  readonly platform: NodeJS.Platform;

  /**
   * Every user store that may hold sandbox records: the instance's, and each store a run was started for (or that
   * app.ts registers at startup), so records, pages and cleanup work for every user's runs.
   */
  private readonly stores = new Set<UserStore>();

  /** Registers a user's store: its sandbox records are looked up, watched and cleaned up too. */
  addStore(us: UserStore): void {
    this.stores.add(us);
  }

  /** The store holding the record `key`, if any. */
  private storeWith(key: string): UserStore | undefined {
    for (const us of this.stores) if (Object.hasOwn(us.get().sandboxes, key)) return us;
    return undefined;
  }

  /** Global build settings (the default recipe, the instance's images) still come from the instance's store. */
  constructor(readonly opts: { config: Config; store: UserStore; instanceId: string; docker?: DockerClient; platform?: NodeJS.Platform }) {
    this.platform = opts.platform ?? process.platform;
    this.docker = opts.docker ?? new DockerClient(opts.config.dockerSocket ?? DEFAULT_SOCKET, this.platform);
    this.stores.add(opts.store);
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

  /**
   * The cached status; "building" while the image build runs. Re-runs init when never run, after a build (a cached
   * "building"), or when it is unavailable and the last check is older than 10 s.
   */
  async status(): Promise<SandboxStatus> {
    if (this.isBuilding()) return { available: false, building: true, clisReady: this.clisReady(), reason: BUILDING_REASON };
    if (this.pending) return this.pending;
    const last = this.last;
    if (!last || last.status.building || (!last.status.available && Date.now() - last.at > RETRY_MS)) return this.init();
    return last.status;
  }

  /** True when the tools and the gm-clis volume can be mounted into sandboxes (start() checks the same). */
  private clisReady(): boolean {
    return !!this.toolsMount() && !!this.clisMount();
  }

  /** True while the images are built, or init() prepares the tools before it starts the build. */
  isBuilding(): boolean {
    return this.build.state === "building" || this.build.state === "queued" || this.preparing;
  }

  /**
   * Rebuild: both images again without the build cache. "building" when a build already runs (or was already asked
   * for); an error reason when Docker or the tools are not ready.
   */
  async rebuild(): Promise<{ ok: true } | { ok: false; code: 400 | 409; error: string }> {
    if (this.build.state === "building" || this.build.state === "queued" || this.forceNext) return { ok: false, code: 409, error: "the sandbox image is building" };
    const force = { force: true, clis: true };
    if (!this.canBuild()) {
      // init() starts the build once the tools are ready: make that one the forced build.
      this.forceNext = force;
      if (this.preparing) return { ok: true };
      const st = await this.status();
      // init() took the request (it clears forceNext) and, with the tools ready, started the forced build.
      if (this.forceNext === undefined && this.canBuild()) return { ok: true };
      this.forceNext = undefined;
      if (!this.canBuild()) return { ok: false, code: 400, error: st.reason ?? "sandboxes are not available" };
      if (this.isBuilding()) return { ok: false, code: 409, error: "the sandbox image is building" };
    }
    void this.ensureImages(force);
    return { ok: true };
  }

  /** A copy of the image build's state. */
  buildState(): SandboxBuild {
    return { ...this.build, log: [...this.build.log] };
  }

  /**
   * Builds the sandbox images in the background, unless a build already runs (then that one is returned). Never
   * rejects: a failure is kept in buildState() and the status.
   */
  ensureImages(opts: { force?: boolean; clis?: boolean } = {}): Promise<void> {
    if (this.building) return this.building;
    const build: SandboxBuild = this.queued > 0 ? { state: "queued", log: [] } : { state: "building", startedAt: new Date().toISOString(), log: [] };
    this.build = build;
    this.building = this.serial(() => {
      build.state = "building";
      build.startedAt ??= new Date().toISOString();
      return this.buildImages({
        ...opts,
        onLine: (l) => pushLine(build, l),
        onStep: (s) => {
          build.step = s;
        },
      });
    })
      .then(
        async (res) => {
          this.image = res.image;
          this.clisVolume = res.clisVolume;
          build.state = "ready";
          build.finishedAt = new Date().toISOString();
          this.last = { status: { available: true, building: false, defaultImage: this.defaultImage() }, at: Date.now() };
          await this.queueMissingWorkspaceBuilds().catch(() => undefined);
        },
        (err: unknown) => {
          build.state = "failed";
          build.error = messageOf(err);
          build.finishedAt = new Date().toISOString();
          this.last = { status: failedStatus(build.error), at: Date.now() };
          // Workspace builds make sure the CLIs exist themselves, so they need not wait for a working global recipe.
          return this.queueMissingWorkspaceBuilds().catch(() => undefined);
        },
      )
      .finally(() => {
        this.building = undefined;
      });
    return this.building;
  }

  /**
   * Builds the provider CLIs image when missing (`force` with `clis`: again, without cache) and fills its gm-clis volume,
   * then the sandbox image of the recipe when missing (`force`: again, without cache). Removes the older labelled images
   * and the other gm-clis volumes (those still in use stay). Returns the default image and the volume.
   */
  protected async buildImages(opts: {
    force?: boolean;
    clis?: boolean;
    onLine: (l: string) => void;
    onStep: (s: "clis" | "image") => void;
  }): Promise<{ image: string; clisVolume: string }> {
    opts.onStep("clis");
    const instance = this.instanceId();
    const cli = await ensureCliImage(this.docker, GM_VERSION, { force: !!(opts.force && opts.clis), onLine: opts.onLine, instance });
    const clisVolume = await ensureClisVolume(this.docker, cli, instance);
    opts.onStep("image");
    const sb = await ensureSandboxImage(this.docker, this.recipe(), { force: !!opts.force, onLine: opts.onLine, instance });
    await this.cleanup(clisVolume);
    return { image: sb.tag, clisVolume };
  }

  /** This graph-manager's id (the instance's `instanceId`), on every image and gm-clis volume it makes. */
  instanceId(): string {
    return this.opts.instanceId;
  }

  /**
   * Removes this graph-manager's older images (all but the CLI, global and workspace recipe images) and its gm-clis
   * volumes other than `keepVolume`. Images and volumes of other graph-manager instances, or without the instance
   * label, are left alone (review F5); ones a container still uses are skipped by Docker (409).
   */
  private async cleanup(keepVolume: string): Promise<void> {
    const instance = this.instanceId();
    await removeOldImages(this.docker, await this.keepIds(), instance);
    for (const v of await this.docker.listVolumes(CLIS_LABEL)) {
      if (v.Name !== keepVolume && v.Labels?.[INSTANCE_LABEL] === instance) await this.docker.removeVolume(v.Name);
    }
  }

  /**
   * Makes sure the gm-clis volume a sandbox will mount still exists (review F5: another graph-manager, or a `docker volume
   * prune`, may have removed it, and Docker would then mount a new empty volume of that name: no CLIs). A missing one is
   * filled again from the CLI image. Returns false when the CLI image is gone too: the caller rebuilds and answers 409.
   */
  private async ensureClisMounted(): Promise<boolean> {
    const name = this.clisVolume;
    if (!name) return false;
    // Docker not answering here: let the container create report it.
    if (await this.docker.inspectVolume(name).catch(() => true)) return true;
    const tag = cliImageTag(GM_VERSION);
    const info = await this.docker.inspectImage(tag).catch(() => undefined);
    if (!info) {
      this.clisVolume = undefined;
      return false;
    }
    try {
      this.clisVolume = await ensureClisVolume(this.docker, { tag, id: info.Id }, this.instanceId());
    } catch (err) {
      throw new SandboxError(400, `cannot fill the CLI volume ${name} again: ${messageOf(err)}`);
    }
    return true;
  }

  /** Runs `fn` after every build queued before it; a rejection never breaks the chain. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    this.queued++;
    const run = this.queue.then(fn).finally(() => {
      this.queued--;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The ids of the images cleanup keeps: the CLI image, the global recipe's image and every workspace recipe's image. */
  private async keepIds(): Promise<string[]> {
    const tags = new Set([cliImageTag(GM_VERSION), sandboxImageTag(sandboxDockerfile(this.recipe()))]);
    for (const id of Object.keys(this.opts.store.get().workspaceSettings)) {
      const sel = this.imageFor(id);
      if (sel.source === "recipe") tags.add(sel.image);
    }
    const ids: string[] = [];
    for (const tag of tags) {
      const info = await this.docker.inspectImage(tag).catch(() => undefined);
      if (info) ids.push(info.Id);
    }
    return ids;
  }

  /** The image source of a workspace and its image. */
  imageFor(wsId: string): { source: ImageSource; image: string } {
    const { source, image } = this.imageForData(this.opts.store.get(), wsId);
    return { source, image };
  }

  /**
   * The image source of a workspace in a given user's data (a session's owner) and its image. `recipe` is set when the
   * image is built from a recipe graph-manager owns: the workspace's own, or the user's global recipe when it differs
   * from the instance's (the instance's global image is `defaultImage()`, built by init).
   */
  imageForData(data: Data, wsId: string): { source: ImageSource; image: string; recipe?: SandboxRecipe } {
    const s = Object.hasOwn(data.workspaceSettings, wsId) ? data.workspaceSettings[wsId] : undefined;
    if (s?.image) return { source: "image", image: s.image };
    if (s?.recipe) return { source: "recipe", image: sandboxImageTag(sandboxDockerfile(s.recipe)), recipe: s.recipe };
    const own = data.sandboxRecipe;
    if (own) {
      const tag = sandboxImageTag(sandboxDockerfile(own));
      if (tag !== sandboxImageTag(sandboxDockerfile(this.recipe()))) return { source: "global", image: tag, recipe: own };
    }
    return { source: "global", image: this.defaultImage() };
  }

  /** The recipe images queued or built for users (by tag). */
  private readonly recipeBuilds = new Set<string>();

  /**
   * Queues the build of a user's recipe image (a session owner's own global or workspace recipe) unless it is queued
   * already. Never rejects: a failure is logged, and the next session start queues it again.
   */
  queueRecipeBuild(recipe: SandboxRecipe): void {
    const tag = sandboxImageTag(sandboxDockerfile(recipe));
    if (this.recipeBuilds.has(tag)) return;
    this.recipeBuilds.add(tag);
    void this.serial(() => ensureSandboxImage(this.docker, recipe, { instance: this.instanceId() }))
      .catch((err: unknown) => console.error(`building ${tag} failed: ${messageOf(err)}`))
      .finally(() => this.recipeBuilds.delete(tag));
  }

  /** A copy of the build state of a workspace's own recipe image. */
  wsBuildState(wsId: string): SandboxBuild {
    const b = this.wsBuilds.get(wsId);
    return b ? { ...b, log: [...b.log] } : { state: "idle", log: [] };
  }

  /** Forgets a workspace's failed build, for example when its saved recipe's image already exists. */
  clearWsFailure(wsId: string): void {
    if (this.wsBuilds.get(wsId)?.state === "failed") this.wsBuilds.delete(wsId);
  }

  /** True while the workspace's own image is queued or built. */
  isWsBuilding(wsId: string): boolean {
    const state = this.wsBuilds.get(wsId)?.state;
    return state === "queued" || state === "building";
  }

  /**
   * Queues the build of a workspace's own recipe image (`force`: again, without the cache), unless it is already queued
   * or built, or the workspace has no own recipe. Never rejects: a failure is kept in wsBuildState().
   */
  queueWorkspaceBuild(wsId: string, opts: { force?: boolean } = {}): void {
    if (this.isWsBuilding(wsId) || this.imageFor(wsId).source !== "recipe") return;
    const build: SandboxBuild = { state: "queued", log: [] };
    this.wsBuilds.set(wsId, build);
    const onLine = (l: string): void => pushLine(build, l);
    void this.serial(async () => {
      build.state = "building";
      build.startedAt = new Date().toISOString();
      build.step = "clis";
      // Always check Docker: the CLI image and its volume may have been pruned since the last build.
      const instance = this.instanceId();
      const cli = await ensureCliImage(this.docker, GM_VERSION, { onLine, instance });
      this.clisVolume = await ensureClisVolume(this.docker, cli, instance);
      build.step = "image";
      // The recipe as saved now: it may have changed while the build waited.
      const recipe = this.opts.store.get().workspaceSettings[wsId]?.recipe;
      if (recipe && !this.opts.store.get().workspaceSettings[wsId]?.image) {
        await ensureSandboxImage(this.docker, recipe, { force: !!opts.force, onLine, instance });
      }
      build.state = "ready";
      build.finishedAt = new Date().toISOString();
      await removeOldImages(this.docker, await this.keepIds(), instance).catch(() => undefined);
    }).catch((err: unknown) => {
      build.state = "failed";
      build.error = messageOf(err);
      build.finishedAt = new Date().toISOString();
    });
  }

  /** Queues the build of every workspace recipe image that is missing, except those whose last build failed. */
  private async queueMissingWorkspaceBuilds(): Promise<void> {
    for (const id of Object.keys(this.opts.store.get().workspaceSettings)) {
      const sel = this.imageFor(id);
      if (sel.source !== "recipe" || this.wsBuilds.get(id)?.state === "failed" || this.isWsBuilding(id)) continue;
      // An unreachable daemon throws here and stops the loop, rather than queueing builds that would fail.
      if (!(await this.docker.inspectImage(sel.image))) this.queueWorkspaceBuild(id);
    }
  }

  /** The recipe of the default sandbox image: the saved one, else the default (with config.sandboxImage as its base). */
  recipe(): SandboxRecipe {
    return this.opts.store.get().sandboxRecipe ?? defaultRecipe(this.opts.config);
  }

  /** The default image: the built one, else the tag of the current recipe's image. */
  defaultImage(): string {
    return this.image ?? sandboxImageTag(sandboxDockerfile(this.recipe()));
  }

  /** True once Docker answered and the tools are ready: a recipe save or Rebuild can start a build. */
  canBuild(): boolean {
    return this.mount !== undefined;
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

  /** The read-only mount of the gm-clis volume for sandbox containers; set by a successful image build. */
  clisMount(): ToolsMount | undefined {
    return this.clisVolume ? { Type: "volume", Source: this.clisVolume, Target: CLIS_TARGET, ReadOnly: true } : undefined;
  }

  /** The stored sandbox record of a run, if any. */
  recordOf(wsId: string, runId: string, us?: UserStore): SandboxRecord | undefined {
    const key = recordKey(wsId, runId);
    if (us) return Object.hasOwn(us.get().sandboxes, key) ? us.get().sandboxes[key] : undefined;
    return this.storeWith(key)?.get().sandboxes[key];
  }

  /**
   * Starts a run in its own container: creates it, copies the provider logins in, starts it, saves the record and
   * waits for the engine's ready file. Throws a `SandboxError` (and leaves no container) when that fails.
   */
  async start(p: StartParams): Promise<SandboxRecord> {
    const { docker } = this;
    const { config } = this.opts;
    const store = p.store ?? this.opts.store;
    this.addStore(store);
    let sel: { source: ImageSource; image: string } = p.image ? { source: "image", image: p.image } : this.imageFor(p.ws.id);
    if (!p.image && store !== this.opts.store) {
      // Another user's run: their own image settings. A recipe image of theirs is built by the shared queue first.
      const own = this.imageForData(store.get(), p.ws.id);
      if (own.recipe) {
        if (!(await docker.imageExists(own.image).catch(() => true))) {
          this.queueRecipeBuild(own.recipe);
          throw new SandboxError(409, WS_BUILDING_START);
        }
        sel = { source: "image", image: own.image };
      } else sel = { source: own.source, image: own.image };
    }
    let image = sel.image;
    if (sel.source === "recipe") {
      // The workspace's own image: it never waits for the global image build, and is never pulled.
      const b = this.wsBuilds.get(p.ws.id);
      if (b?.state === "queued" || b?.state === "building") throw new SandboxError(409, WS_BUILDING_START);
      if (b?.state === "failed") throw new SandboxError(400, `the sandbox image build failed: ${b.error}`);
      if (!this.isBuilding()) {
        const st = await this.status();
        // A failed global build doesn't concern this workspace; Docker being unreachable does.
        if (!st.available && !st.building && st.reason !== failedStatus(this.build.error).reason) {
          throw new SandboxError(400, st.reason ?? "sandboxes are not available");
        }
      }
      if (!(await docker.imageExists(image).catch(() => true))) {
        this.queueWorkspaceBuild(p.ws.id);
        throw new SandboxError(409, WS_BUILDING_START);
      }
      if (!this.toolsMount()) {
        if (this.preparing) throw new SandboxError(409, WS_BUILDING_START);
        throw new SandboxError(400, "the sandbox tools are not ready");
      }
      if (!this.clisMount()) {
        // The CLI image is still building (the global build), or failed: the workspace build makes it too.
        if (!this.isBuilding()) this.queueWorkspaceBuild(p.ws.id);
        throw new SandboxError(409, WS_BUILDING_START);
      }
    } else {
      if (this.isBuilding()) throw new SandboxError(409, BUILDING_START);
      const st = await this.status();
      if (st.building) throw new SandboxError(409, BUILDING_START);
      if (!st.available) throw new SandboxError(400, st.reason ?? "sandboxes are not available");
      // The global image is known once the status checked (the first one builds it).
      if (sel.source === "global") image = this.defaultImage();
      const exists = await docker.imageExists(image).catch(() => true);
      if (!exists && image === this.image && image.startsWith(`${SANDBOX_IMAGE_REPO}:`)) {
        // The built image went missing (an image prune): build it again rather than pull it from a registry.
        this.image = undefined;
        void this.ensureImages();
        throw new SandboxError(409, BUILDING_START);
      }
      if (!exists) {
        try {
          await docker.pullImage(image);
        } catch (err) {
          throw new SandboxError(400, `cannot pull the sandbox image ${image}: ${messageOf(err)}`);
        }
      }
    }
    const tools = this.toolsMount();
    if (!tools) throw new SandboxError(400, "the sandbox tools are not ready");
    if (this.clisVolume && !(await this.ensureClisMounted())) {
      // The CLI image is gone as well: build it again (the workspace build or the global one makes it).
      if (sel.source === "recipe") {
        this.queueWorkspaceBuild(p.ws.id);
        throw new SandboxError(409, WS_BUILDING_START);
      }
      void this.ensureImages();
      throw new SandboxError(409, BUILDING_START);
    }
    const clis = this.clisMount();
    if (!clis) throw new SandboxError(400, "the sandbox tools are not ready");
    // Docker does not expand $PATH in Env: the sandbox's PATH ends with its image's own.
    const imagePath = (await docker.inspectImage(image).catch(() => undefined))?.Config?.Env?.find((e) => e.startsWith("PATH="))?.slice(5);

    // On a Windows host the container sees the workspace at /workspaces/<rel>: what goes into the container is
    // translated below (sandbox-paths.ts); graph-manager's own file access keeps the host paths.
    const pf = this.platform;
    const runDir = path.join(p.ws.path, RUNS_DIR, p.runId);
    const readyFile = path.join(runDir, ".ready.json");
    await rm(readyFile, { force: true });
    const st2 = await stat(p.ws.path);
    // stat reports uid 0 on Windows, and provider CLIs refuse to run unattended as root.
    const owner = pf === "win32" ? { uid: 1000, gid: 1000 } : { uid: st2.uid, gid: st2.gid };
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
    const reviewers = await readReviewers(resuming ? path.join(runDir, RUN_REVIEWERS_FILE) : (p.reviewersFile ?? reviewersFilePath(config.dataDir)));
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

    const baseEnv: NodeJS.ProcessEnv = { ...process.env, ...p.extraEnv };
    const env = sandboxEnv(baseEnv, {
      runId: p.runId,
      runDir: toContainer(p.ws, runDir, pf),
      image,
      token,
      ...(p.takeLockFrom ? { takeLockFrom: p.takeLockFrom } : {}),
      gitIdentity: await gitIdentity(p.ws.path),
      ...(imagePath ? { imagePath } : {}),
      ...(pf === "win32" ? { gitConfig: await windowsGitConfig(p.ws.path) } : {}),
    }).filter((e) => !e.startsWith(`${REVIEWERS_ENV}=`));
    if (reviewersCopy) env.push(`${REVIEWERS_ENV}=${toContainer(p.ws, reviewersCopy, pf)}`);
    const repos = p.repos ?? [];
    const mounts = [
      workspaceMount(p.ws, config.workspacesDir, this.self, config.sandboxWorkspacesSource, pf),
      ...repoMounts(p.ws, repos.map((r) => r.workspace), repos.map((r) => r.link), config.workspacesDir, this.self, config.sandboxWorkspacesSource, pf),
      tools,
      clis,
    ];
    const body = containerBody({
      image,
      hostname: host,
      owner,
      env,
      args: toContainerArgs(p.ws, p.args, pf),
      cwd: toContainer(p.ws, p.cwd, pf),
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
      if (rec) await this.dropRecord(key, id, store).catch(() => undefined);
    };
    try {
      await docker.putArchive(id, "/", tarArchive(await loginEntries(providers, os.homedir(), baseEnv), owner));
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
  private async dropRecord(key: string, container: string, us?: UserStore): Promise<void> {
    const store = us ?? this.storeWith(key);
    if (store?.get().sandboxes[key]?.container !== container) return;
    await store.update((d) => {
      if (d.sandboxes[key]?.container === container) delete d.sandboxes[key];
    });
  }

  /** Checks the stored records against Docker: gone or stopped containers are cleaned up, running ones watched. */
  private async reconcile(): Promise<void> {
    for (const [key, rec] of [...this.stores].flatMap((us) => Object.entries(us.get().sandboxes))) {
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
    const records = [...this.stores].flatMap((us) => Object.values(us.get().sandboxes).map((r) => ({ r, us })));
    if (records.length === 0) return undefined;
    const dir = path.resolve(runDir);
    const rec = records.find(({ r, us }) => {
      // A project run's record is keyed `project~<id>`: its home is the project folder (of the record's owner).
      const home = resolveRunHome(this.opts.config.workspacesDir, us, r.workspace);
      return home !== undefined && path.join(home.path, RUNS_DIR, r.runId) === dir;
    })?.r;
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
      if (this.platform === "win32" || this.platform === "darwin") reason += "; is Docker Desktop running?";
      return { available: false, reason };
    }
    // Sandboxes are Linux containers. A daemon that does not answer /info, or without OSType, goes on as before.
    const osType = await this.docker.info().then(
      (i) => i.OSType,
      () => undefined,
    );
    if (osType !== undefined && osType !== "linux") {
      return { available: false, reason: "Docker is running Windows containers: switch Docker Desktop to Linux containers" };
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
    let toolsError: string | undefined;
    this.preparing = true;
    try {
      toolsError = await this.prepareTools();
    } finally {
      this.preparing = false;
    }
    const force = this.forceNext;
    this.forceNext = undefined;
    if (toolsError !== undefined) return { available: false, reason: toolsError };
    if (force) {
      void this.ensureImages(force);
      await this.reconcile();
      return this.imagesStatus();
    }
    // No automatic rebuild after a failure: the user saves the recipe or presses Rebuild.
    if (this.build.state === "failed") {
      await this.reconcile();
      return failedStatus(this.build.error);
    }
    const p = this.ensureImages();
    await Promise.race([p, sleep(INIT_WAIT_MS)]);
    await this.reconcile();
    return this.imagesStatus();
  }

  /** The status after the tools are ready, by the image build's state. */
  private imagesStatus(): SandboxStatus {
    const state = this.build.state;
    if (state === "ready") return { available: true, building: false, defaultImage: this.defaultImage() };
    if (state === "failed") return failedStatus(this.build.error);
    return { available: false, building: true, reason: BUILDING_REASON };
  }
}
