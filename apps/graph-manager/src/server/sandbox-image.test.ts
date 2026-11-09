import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDocker, startFakeDocker } from "../../scripts/fake-docker.mjs";
import { DockerClient } from "./docker.js";
import { Sandboxes, type StartParams, type ToolsMount } from "./sandbox.js";
import {
  cliDockerfile,
  cliImageTag,
  clisVolumeName,
  DEFAULT_RECIPE,
  defaultRecipe,
  ensureCliImage,
  ensureClisVolume,
  migrateRecipe,
  normalizeRecipe,
  INSTANCE_LABEL,
  removeOldImages,
  type SandboxRecipe,
  sandboxDockerfile,
  sandboxImageTag,
  TOOLCHAIN_IDS,
  TOOLCHAINS,
  type ToolchainId,
  validateRecipe,
} from "./sandbox-image.js";
import { SandboxError } from "./sandbox-run.js";
import { DataStore } from "./store.js";
import { tempDir, testConfig } from "./test-helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
const fakes: FakeDocker[] = [];
let savedHost: string | undefined;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  savedHost = process.env.HOSTNAME;
  process.env.HOSTNAME = "gmself000000";
  // The tools step is covered by sandbox-tools.test.ts.
  vi.spyOn(Sandboxes.prototype as unknown as { prepareTools: () => Promise<string | undefined> }, "prepareTools").mockImplementation(async function (
    this: { mount?: ToolsMount },
  ) {
    this.mount = { Type: "bind", Source: "/tmp/gm-tools", Target: "/opt/gm-tools", ReadOnly: true };
    return undefined;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fakes.splice(0)) await f.close();
  if (savedHost === undefined) delete process.env.HOSTNAME;
  else process.env.HOSTNAME = savedHost;
  await cleanup();
});

async function fake(opts: Parameters<typeof startFakeDocker>[0] = {}): Promise<FakeDocker> {
  const f = await startFakeDocker(opts);
  fakes.push(f);
  return f;
}

async function sandboxes(f: FakeDocker): Promise<Sandboxes> {
  const config = testConfig(dir, { dockerSocket: f.socketPath });
  return new Sandboxes({ config, store: await DataStore.open(path.join(dir, "data")) });
}

const GM_VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
const DEFAULT_TAG = sandboxImageTag(sandboxDockerfile(DEFAULT_RECIPE));

const until = async (what: string, fn: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("cliDockerfile", () => {
  it("installs the provider CLIs into /opt/gm-clis", () => {
    expect(cliDockerfile()).toBe(
      "FROM node:24.22.1-bookworm-slim\n" +
        "RUN npm install -g --prefix /opt/gm-clis --no-audit --no-fund @anthropic-ai/claude-code @openai/codex @opencode/cli @qwen-code/qwen-code \\\n" +
        " && /opt/gm-clis/bin/claude --version && /opt/gm-clis/bin/codex --version",
    );
    expect(clisVolumeName("sha256:0123456789abcdef0123")).toBe("gm-clis-0123456789ab");
  });
});

describe("ensureCliImage", () => {
  it("builds the image once, and again without cache when forced", async () => {
    const f = await fake();
    const docker = new DockerClient(f.socketPath);
    const lines: string[] = [];
    const a = await ensureCliImage(docker, "1.2.3", { onLine: (l) => lines.push(l) });
    expect(a.tag).toBe("gm-sandbox-clis:1.2.3");
    expect(a.tag).toBe(cliImageTag("1.2.3"));
    expect(a.id).toMatch(/^sha256:/);
    expect(f.builds).toEqual([{ tag: "gm-sandbox-clis:1.2.3", nocache: false, labels: { "gm.sandbox-image": "1" }, dockerfile: cliDockerfile() }]);
    expect(lines.length).toBeGreaterThan(0);

    expect(await ensureCliImage(docker, "1.2.3", {})).toEqual(a);
    expect(f.builds).toHaveLength(1);

    const b = await ensureCliImage(docker, "1.2.3", { force: true });
    expect(f.builds).toHaveLength(2);
    expect(f.builds[1]?.nocache).toBe(true);
    expect(b.id).not.toBe(a.id);
  });
});

describe("ensureClisVolume", () => {
  it("creates the volume once and fills it with a fill container that is removed", async () => {
    const f = await fake();
    const docker = new DockerClient(f.socketPath);
    const image = await ensureCliImage(docker, "1.2.3", {});
    const name = await ensureClisVolume(docker, image);
    expect(name).toBe(`gm-clis-${image.id.slice("sha256:".length, "sha256:".length + 12)}`);
    expect(f.volumes.get(name)?.Labels).toEqual({ "gm.clis": "1" });
    const creates = f.requests.filter((r) => r.path === "/containers/create");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toMatchObject({
      Image: image.tag,
      Cmd: ["true"],
      Labels: { "gm.clis-fill": "1" },
      HostConfig: { Mounts: [{ Type: "volume", Source: name, Target: "/opt/gm-clis" }] },
    });
    expect(f.containers.size).toBe(0);

    // An existing volume is not created again; the fill container runs again (Docker fills it only when it is empty).
    expect(await ensureClisVolume(docker, image)).toBe(name);
    expect(f.requests.filter((r) => r.path === "/volumes/create")).toHaveLength(1);
    expect(f.requests.filter((r) => r.path === "/containers/create")).toHaveLength(2);
    expect(f.containers.size).toBe(0);
  });
});

describe("removeOldImages", () => {
  it("removes the gm-sandbox tags of old images by name, dangling ones by id, and keeps the others", async () => {
    const removed: string[] = [];
    const docker = {
      listImages: async () => [
        { Id: "sha256:keep", RepoTags: ["gm-sandbox:new"] },
        { Id: "sha256:old", RepoTags: ["gm-sandbox:old", "mine:1"] },
        { Id: "sha256:clis", RepoTags: ["gm-sandbox-clis:0.0.1"] },
        { Id: "sha256:dangling", RepoTags: [] },
      ],
      removeImage: async (n: string) => {
        removed.push(n);
      },
    } as unknown as DockerClient;
    await removeOldImages(docker, ["sha256:keep"]);
    expect(removed).toEqual(["gm-sandbox:old", "gm-sandbox-clis:0.0.1", "sha256:dangling"]);
  });
});

const APT_PYTHON = "RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv pipx && rm -rf /var/lib/apt/lists/*";

/** The default recipe with the toolchains `ids` enabled. */
function withEnabled(...ids: ToolchainId[]): SandboxRecipe {
  const r = defaultRecipe({});
  for (const t of r.toolchains) if (ids.includes(t.id)) t.enabled = true;
  return r;
}

describe("removeOldImages with an instance (review F5)", () => {
  it("removes only that instance's images, never another instance's or unlabelled ones", async () => {
    const removed: string[] = [];
    const docker = {
      listImages: async () => [
        { Id: "sha256:mine-old", RepoTags: ["gm-sandbox:a"], Labels: { "gm.sandbox-image": "1", [INSTANCE_LABEL]: "aaaaaaaaaaaaaaaa" } },
        { Id: "sha256:mine-keep", RepoTags: ["gm-sandbox:b"], Labels: { "gm.sandbox-image": "1", [INSTANCE_LABEL]: "aaaaaaaaaaaaaaaa" } },
        { Id: "sha256:theirs", RepoTags: ["gm-sandbox:c"], Labels: { "gm.sandbox-image": "1", [INSTANCE_LABEL]: "bbbbbbbbbbbbbbbb" } },
        { Id: "sha256:legacy", RepoTags: ["gm-sandbox:d"], Labels: { "gm.sandbox-image": "1" } },
      ],
      removeImage: async (n: string) => {
        removed.push(n);
      },
    } as unknown as DockerClient;
    await removeOldImages(docker, ["sha256:mine-keep"], "aaaaaaaaaaaaaaaa");
    expect(removed).toEqual(["gm-sandbox:a"]);
  });
});

describe("sandboxDockerfile", () => {
  it("is FROM only for the default recipe", () => {
    expect(sandboxDockerfile(DEFAULT_RECIPE)).toBe("FROM node:24.22.1-bookworm\n");
    expect(DEFAULT_RECIPE.toolchains.map((t) => t.id)).toEqual(TOOLCHAIN_IDS);
    expect(DEFAULT_RECIPE.toolchains.every((t) => !t.enabled)).toBe(true);
  });

  it("writes each enabled toolchain under a comment, in the recipe's order", () => {
    expect(sandboxDockerfile(withEnabled("python"))).toBe(`FROM node:24.22.1-bookworm\n# Python\n${APT_PYTHON}\n`);
    const r = withEnabled("python", "rust");
    const rust = r.toolchains.findIndex((t) => t.id === "rust");
    const [moved] = r.toolchains.splice(rust, 1);
    if (moved) r.toolchains.unshift(moved);
    const d = sandboxDockerfile(r);
    expect(d.indexOf("# Rust")).toBeGreaterThan(0);
    expect(d.indexOf("# Rust")).toBeLessThan(d.indexOf("# Python"));
  });

  it("adds nothing for a disabled toolchain, even with an edited snippet", () => {
    const r = defaultRecipe({});
    for (const t of r.toolchains) if (t.id === "go") t.snippet = "RUN echo edited";
    expect(sandboxDockerfile(r)).toBe("FROM node:24.22.1-bookworm\n");
  });

  it("keeps the extra lines verbatim, heredoc indentation included (F7)", () => {
    const extraLines = "RUN <<EOF\n  set -e\n    echo hi\nEOF";
    expect(sandboxDockerfile({ ...defaultRecipe({}), base: " debian:12 ", extraLines })).toBe(`FROM debian:12\n${extraLines}\n`);
    expect(sandboxDockerfile({ ...defaultRecipe({}), extraLines: "RUN a\r\n\nRUN b\n\n\n" })).toBe("FROM node:24.22.1-bookworm\nRUN a\n\nRUN b\n");
    expect(sandboxDockerfile({ ...defaultRecipe({}), extraLines: " \n" })).toBe("FROM node:24.22.1-bookworm\n");
  });

  it("tags by the Dockerfile's hash", () => {
    const tag = sandboxImageTag(sandboxDockerfile(DEFAULT_RECIPE));
    expect(tag).toMatch(/^gm-sandbox:[0-9a-f]{12}$/);
    expect(sandboxImageTag(sandboxDockerfile(defaultRecipe({})))).toBe(tag);
    expect(sandboxImageTag(sandboxDockerfile(withEnabled("go")))).not.toBe(tag);
  });

  it("uses GM_SANDBOX_IMAGE as the default recipe's base, and copies the default", () => {
    expect(defaultRecipe({ sandboxImage: "debian:12" }).base).toBe("debian:12");
    expect(defaultRecipe({})).toEqual(DEFAULT_RECIPE);
    const r = defaultRecipe({});
    const t0 = r.toolchains[0];
    if (t0) {
      t0.enabled = true;
      t0.snippet = "RUN changed";
    }
    r.toolchains.pop();
    expect(DEFAULT_RECIPE.toolchains).toHaveLength(7);
    expect(DEFAULT_RECIPE.toolchains[0]).toEqual({ id: "python", enabled: false, snippet: APT_PYTHON });
    expect(DEFAULT_RECIPE.toolchains.map((t) => t.snippet)).toEqual(TOOLCHAINS.map((t) => t.snippet));
  });
});

describe("normalizeRecipe", () => {
  it("trims the base and drops carriage returns only", () => {
    const r = defaultRecipe({});
    const t0 = r.toolchains[0];
    if (t0) t0.snippet = "RUN a\r\n  RUN b";
    const n = normalizeRecipe({ ...r, base: " node:22 ", extraLines: "  RUN c\r\n" });
    expect(n.base).toBe("node:22");
    expect(n.toolchains[0]?.snippet).toBe("RUN a\n  RUN b");
    expect(n.extraLines).toBe("  RUN c\n");
  });
});

describe("migrateRecipe", () => {
  it("turns the old packages into an apt line before the old extra lines, with every toolchain disabled", () => {
    expect(migrateRecipe({ base: "node:22", packages: ["jq", "curl", "jq"], extraLines: "RUN true" })).toEqual({
      base: "node:22",
      toolchains: DEFAULT_RECIPE.toolchains,
      extraLines: "RUN apt-get update && apt-get install -y --no-install-recommends curl jq && rm -rf /var/lib/apt/lists/*\nRUN true",
    });
    expect(migrateRecipe({ base: "node:22", packages: [" ", ""], extraLines: "RUN true" })).toEqual({ base: "node:22", toolchains: DEFAULT_RECIPE.toolchains, extraLines: "RUN true" });
  });

  it("returns anything else unchanged", () => {
    const r = defaultRecipe({});
    expect(migrateRecipe(r)).toBe(r);
    expect(migrateRecipe(undefined)).toBeUndefined();
    expect(migrateRecipe("x")).toBe("x");
    const both = { ...r, packages: ["jq"] };
    expect(migrateRecipe(both)).toBe(both);
  });
});

describe("validateRecipe", () => {
  const ok = (): SandboxRecipe => ({ ...withEnabled("python"), base: "node:22", extraLines: "RUN true" });
  const snippet = (id: ToolchainId, text: string): SandboxRecipe => {
    const r = ok();
    for (const t of r.toolchains) if (t.id === id) t.snippet = text;
    return r;
  };
  it("accepts a valid recipe and the default", () => {
    expect(validateRecipe(ok())).toBeUndefined();
    expect(validateRecipe(DEFAULT_RECIPE)).toBeUndefined();
  });
  it("answers the message of the first problem", () => {
    const fromMsg = "extraLines: FROM is not allowed; use COPY --from=<image>";
    expect(validateRecipe({ ...ok(), extraLines: "RUN true\nFROM ubuntu" })).toBe(fromMsg);
    expect(validateRecipe({ ...ok(), extraLines: "  from ubuntu" })).toBe(fromMsg);
    expect(validateRecipe({ ...ok(), extraLines: "COPY --from=ubuntu /a /a" })).toBeUndefined();
    expect(validateRecipe({ ...ok(), base: "bad image!" })).toBe("base: not a valid image reference");
    expect(validateRecipe({ ...ok(), extraLines: "x".repeat(20001) })).toBe("extraLines: at most 20000 characters");
    expect(validateRecipe(snippet("python", "RUN true\n  from ubuntu"))).toBe("toolchains.python: FROM is not allowed; use COPY --from=<image>");
    expect(validateRecipe(snippet("go", "x".repeat(20001)))).toBe("toolchains.go: at most 20000 characters");
    // A disabled toolchain's snippet is checked too.
    expect(validateRecipe(snippet("cpp", "FROM gcc"))).toBe("toolchains.cpp: FROM is not allowed; use COPY --from=<image>");
  });
  it("requires each toolchain exactly once", () => {
    const msg = "toolchains: must list each of python, java, go, rust, ruby, php, cpp exactly once";
    const missing = ok();
    missing.toolchains.pop();
    expect(validateRecipe(missing)).toBe(msg);
    const dup = ok();
    const first = dup.toolchains[0];
    if (first) dup.toolchains[6] = { ...first };
    expect(validateRecipe(dup)).toBe(msg);
    const extra = ok();
    const last = extra.toolchains[6];
    if (last) extra.toolchains.push({ ...last });
    expect(validateRecipe(extra)).toBe(msg);
  });
});

describe("Sandboxes image build", () => {
  const params = { ws: { id: "github~o~r", path: "/nonexistent" }, cwd: "/nonexistent", args: [], runId: "r1", providers: [] } as unknown as StartParams;

  it("answers 'building' at once, refuses starts with 409, then becomes available", async () => {
    const f = await fake({ buildDelayMs: 1500 });
    const s = await sandboxes(f);
    const t0 = Date.now();
    expect(await s.init()).toEqual({ available: false, building: true, reason: "building the sandbox image" });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(s.buildState()).toMatchObject({ state: "building", step: "clis" });
    expect(await s.status()).toEqual({ available: false, building: true, clisReady: false, reason: "building the sandbox image" });

    const err = await s.start(params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).status).toBe(409);
    expect((err as SandboxError).message).toBe("the sandbox image is building; try again when it is ready");

    await until("the build", () => s.buildState().state !== "building");
    expect(s.buildState().state).toBe("ready");
    expect(await s.status()).toEqual({ available: true, building: false, defaultImage: DEFAULT_TAG });
    const volume = [...f.volumes.keys()].find((n) => n.startsWith("gm-clis-"));
    expect(volume).toBeDefined();
    expect(s.clisMount()).toEqual({ Type: "volume", Source: volume, Target: "/opt/gm-clis", ReadOnly: true });

    await s.init();
    expect(f.builds).toHaveLength(2);

    // The built image pruned by hand: a start builds it again (409 meanwhile) instead of pulling gm-sandbox:<hash>.
    await new DockerClient(f.socketPath).removeImage(DEFAULT_TAG);
    const gone = await s.start(params).catch((e: unknown) => e);
    expect((gone as SandboxError).status).toBe(409);
    await until("the rebuild", () => s.buildState().state !== "building");
    expect(f.builds.map((b) => b.tag)).toEqual([expect.stringMatching(/^gm-sandbox-clis:/), DEFAULT_TAG, DEFAULT_TAG]);
    expect(f.requests.some((r) => r.path === "/images/create")).toBe(false);
  });

  it("builds the CLI image, then the recipe's image, labelled and with the cache", async () => {
    const f = await fake();
    const s = await sandboxes(f);
    expect((await s.init()).available).toBe(true);
    const labels = { "gm.sandbox-image": "1", [INSTANCE_LABEL]: s.instanceId() };
    expect(f.builds.map((b) => ({ tag: b.tag, nocache: b.nocache, labels: b.labels }))).toEqual([
      { tag: cliImageTag(GM_VERSION), nocache: false, labels },
      { tag: DEFAULT_TAG, nocache: false, labels },
    ]);
    expect(f.builds[1]?.dockerfile).toBe(sandboxDockerfile(DEFAULT_RECIPE));
    expect(s.defaultImage()).toBe(DEFAULT_TAG);
    expect((await s.status()).defaultImage).toBe(DEFAULT_TAG);
  });

  it("builds only the sandbox image for a new recipe and removes the previous one", async () => {
    const f = await fake();
    const s = await sandboxes(f);
    expect((await s.init()).available).toBe(true);
    const docker = new DockerClient(f.socketPath);
    const recipe: SandboxRecipe = { ...withEnabled("python"), extraLines: "RUN true" };
    await s.opts.store.update((d) => {
      d.sandboxRecipe = recipe;
    });
    await s.ensureImages();
    const tag = sandboxImageTag(sandboxDockerfile(recipe));
    expect(f.builds).toHaveLength(3);
    expect(f.builds[2]).toMatchObject({ tag, nocache: false });
    expect(f.builds[2]?.dockerfile).toBe(`FROM node:24.22.1-bookworm\n# Python\n${APT_PYTHON}\nRUN true\n`);
    expect(s.defaultImage()).toBe(tag);
    const tags = (await docker.listImages("gm.sandbox-image")).flatMap((i) => i.RepoTags ?? []);
    expect(tags.sort()).toEqual([cliImageTag(GM_VERSION), tag].sort());
  });

  it("rebuilds both images without the cache, with a new gm-clis volume", async () => {
    const f = await fake();
    const s = await sandboxes(f);
    expect((await s.init()).available).toBe(true);
    const docker = new DockerClient(f.socketPath);
    const before = s.clisMount()?.Source;
    await s.ensureImages({ force: true, clis: true });
    expect(s.buildState().state).toBe("ready");
    expect(f.builds.slice(2).map((b) => [b.tag, b.nocache])).toEqual([
      [cliImageTag(GM_VERSION), true],
      [DEFAULT_TAG, true],
    ]);
    const after = s.clisMount()?.Source;
    expect(after).toMatch(/^gm-clis-/);
    expect(after).not.toBe(before);
    expect(f.volumes.has(before ?? "")).toBe(false);
    expect((await docker.listImages("gm.sandbox-image")).flatMap((i) => i.RepoTags ?? []).sort()).toEqual([cliImageTag(GM_VERSION), DEFAULT_TAG].sort());
  });

  it("keeps an old image a container uses", async () => {
    const f = await fake();
    const s = await sandboxes(f);
    expect((await s.init()).available).toBe(true);
    const docker = new DockerClient(f.socketPath);
    await docker.createContainer("user", { Image: DEFAULT_TAG });
    await s.opts.store.update((d) => {
      d.sandboxRecipe = { ...defaultRecipe({}), extraLines: "RUN true" };
    });
    await s.ensureImages();
    expect(s.buildState().state).toBe("ready");
    const tags = (await docker.listImages("gm.sandbox-image")).flatMap((i) => i.RepoTags ?? []);
    expect(tags).toContain(DEFAULT_TAG);
    expect(tags).toContain(s.defaultImage());
    expect(tags).toHaveLength(3);
  });

  it("removes its own other gm-clis volumes, and leaves other instances' and unlabelled ones", async () => {
    const f = await fake();
    const docker = new DockerClient(f.socketPath);
    const s = await sandboxes(f);
    await docker.createVolume("gm-clis-000000000000", { "gm.clis": "1", [INSTANCE_LABEL]: s.instanceId() });
    await docker.createVolume("gm-clis-111111111111", { "gm.clis": "1", [INSTANCE_LABEL]: "ffffffffffffffff" });
    await docker.createVolume("gm-clis-222222222222", { "gm.clis": "1" });
    expect((await s.init()).available).toBe(true);
    const names = [...f.volumes.keys()].filter((n) => n.startsWith("gm-clis-")).sort();
    expect(names).toEqual([s.clisMount()?.Source, "gm-clis-111111111111", "gm-clis-222222222222"].sort());
  });

  it("is unavailable after a failed build and does not build again by itself", async () => {
    const f = await fake();
    const build = vi.spyOn(DockerClient.prototype, "buildImage").mockRejectedValue(new Error("no network"));
    const s = await sandboxes(f);
    const failed = { available: false, building: false, reason: "the sandbox image build failed: no network" };
    expect(await s.init()).toEqual(failed);
    expect(await s.status()).toEqual(failed);
    expect(s.buildState()).toMatchObject({ state: "failed", error: "no network" });
    expect(build).toHaveBeenCalledTimes(1);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11_000);
    expect(await s.status()).toEqual(failed);
    expect(build).toHaveBeenCalledTimes(1);
    expect(s.clisMount()).toBeUndefined();
  });
});

describe("workspace recipes", () => {
  const WS = "github~o~r";
  const OTHER = "github~o~other";
  const params = (id: string) => ({ ws: { id, path: "/nonexistent" }, cwd: "/nonexistent", args: [], runId: "r1", providers: [] }) as unknown as StartParams;
  const javaRecipe = (extraLines = ""): SandboxRecipe => ({ ...withEnabled("java"), base: "node:22-bookworm", extraLines });
  const setRecipe = (s: Sandboxes, id: string, recipe: SandboxRecipe) =>
    s.opts.store.update((d) => {
      d.workspaceSettings[id] = { recipe };
    });
  const errorOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

  it("builds the workspace's own image after the global one", async () => {
    const f = await fake({ buildDelayMs: 300 });
    const s = await sandboxes(f);
    const recipe = javaRecipe();
    const tag = sandboxImageTag(sandboxDockerfile(recipe));
    expect((await s.init()).building).toBe(true);
    await setRecipe(s, WS, recipe);
    expect(s.wsBuildState(WS)).toEqual({ state: "idle", log: [] });
    s.queueWorkspaceBuild(WS);
    const states = new Set<string>([s.wsBuildState(WS).state]);
    await until("the workspace build", () => {
      states.add(s.wsBuildState(WS).state);
      return s.wsBuildState(WS).state === "ready" || s.wsBuildState(WS).state === "failed";
    });
    expect([...states]).toEqual(["queued", "building", "ready"]);
    expect(s.wsBuildState(WS).log.length).toBeGreaterThan(0);
    expect(f.builds.map((b) => b.tag)).toEqual([cliImageTag(GM_VERSION), DEFAULT_TAG, tag]);
    expect(f.builds[2]?.dockerfile.startsWith("FROM node:22-bookworm\n# Java\n")).toBe(true);
    expect(s.imageFor(WS)).toEqual({ source: "recipe", image: tag });
    expect(s.imageFor(OTHER)).toEqual({ source: "global", image: DEFAULT_TAG });
  });

  it("refuses a start of that workspace while it builds, not of another one", async () => {
    const f = await fake({ exec: false, buildDelayMs: 1500 });
    const s = await sandboxes(f);
    await setRecipe(s, WS, javaRecipe());
    // The global images first, so only the workspace image builds below.
    await s.init();
    await until("the global build", () => s.buildState().state !== "building");
    s.queueWorkspaceBuild(WS);
    await until("the workspace build to start", () => s.wsBuildState(WS).state === "building");
    const err = await errorOf(s.start(params(WS)));
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).status).toBe(409);
    expect((err as SandboxError).message).toBe("the sandbox image of this workspace is building; try again when it is ready");
    const other = await errorOf(s.start(params(OTHER)));
    expect((other as SandboxError | undefined)?.message).not.toBe("the sandbox image of this workspace is building; try again when it is ready");
    await until("the workspace build", () => s.wsBuildState(WS).state !== "building");
  }, 15_000);

  it("fails a broken recipe's build, and a start answers 400", async () => {
    const f = await fake();
    const s = await sandboxes(f);
    expect((await s.init()).available).toBe(true);
    await setRecipe(s, WS, javaRecipe("RUN echo FAKE_BUILD_FAIL"));
    s.queueWorkspaceBuild(WS);
    await until("the workspace build", () => !["queued", "building"].includes(s.wsBuildState(WS).state));
    expect(s.wsBuildState(WS)).toMatchObject({ state: "failed", error: expect.stringContaining("fake build failed") });
    const err = await errorOf(s.start(params(WS)));
    expect((err as SandboxError).status).toBe(400);
    expect((err as SandboxError).message).toMatch(/^the sandbox image build failed: .*fake build failed/);
    // The global image is unaffected.
    expect(s.buildState().state).toBe("ready");
  });

  it("keeps every workspace recipe's image on cleanup, and removes unused ones", async () => {
    const f = await fake();
    const s = await sandboxes(f);
    const docker = new DockerClient(f.socketPath);
    expect((await s.init()).available).toBe(true);
    const kept = javaRecipe();
    const dropped = javaRecipe("RUN true");
    await setRecipe(s, OTHER, dropped);
    s.queueWorkspaceBuild(OTHER);
    await until("the first build", () => s.wsBuildState(OTHER).state === "ready");
    await setRecipe(s, WS, kept);
    s.queueWorkspaceBuild(WS);
    await until("the second build", () => s.wsBuildState(WS).state === "ready");
    const keptTag = sandboxImageTag(sandboxDockerfile(kept));
    const droppedTag = sandboxImageTag(sandboxDockerfile(dropped));
    expect(await docker.inspectImage(droppedTag)).toBeDefined();
    // OTHER goes back to the global image: the next global build removes its old recipe's image only.
    await s.opts.store.update((d) => {
      delete d.workspaceSettings[OTHER];
    });
    await s.ensureImages({ force: true });
    expect(s.buildState().state).toBe("ready");
    expect(await docker.inspectImage(keptTag)).toBeDefined();
    expect(await docker.inspectImage(droppedTag)).toBeUndefined();
    expect(await docker.inspectImage(DEFAULT_TAG)).toBeDefined();
    expect(await docker.inspectImage(cliImageTag(GM_VERSION))).toBeDefined();
  });

  it("queues the missing workspace images on init, after the global build", async () => {
    const f = await fake();
    const s = await sandboxes(f);
    const recipe = javaRecipe();
    await setRecipe(s, WS, recipe);
    expect((await s.init()).available).toBe(true);
    await until("the workspace build", () => s.wsBuildState(WS).state === "ready");
    expect(f.builds.map((b) => b.tag)).toEqual([cliImageTag(GM_VERSION), DEFAULT_TAG, sandboxImageTag(sandboxDockerfile(recipe))]);
    // Present now: a later global build doesn't queue it again.
    await s.ensureImages();
    expect(s.wsBuildState(WS).state).toBe("ready");
    expect(f.builds).toHaveLength(3);
  });

  it("runs one build at a time", async () => {
    const f = await fake({ buildDelayMs: 300 });
    const s = await sandboxes(f);
    expect((await s.init()).available).toBe(false);
    await setRecipe(s, WS, javaRecipe());
    await setRecipe(s, OTHER, javaRecipe("RUN true"));
    s.queueWorkspaceBuild(WS);
    s.queueWorkspaceBuild(OTHER);
    expect(s.wsBuildState(WS).state).toBe("queued");
    expect(s.wsBuildState(OTHER).state).toBe("queued");
    // A queued build does nothing more when queued again.
    s.queueWorkspaceBuild(WS);
    const building = (): number =>
      [s.buildState().state, s.wsBuildState(WS).state, s.wsBuildState(OTHER).state].filter((st) => st === "building").length;
    let most = 0;
    await until("both builds", () => {
      most = Math.max(most, building());
      return s.wsBuildState(WS).state === "ready" && s.wsBuildState(OTHER).state === "ready";
    });
    expect(most).toBe(1);
    expect(f.builds.map((b) => b.tag)).toEqual([
      cliImageTag(GM_VERSION),
      DEFAULT_TAG,
      sandboxImageTag(sandboxDockerfile(javaRecipe())),
      sandboxImageTag(sandboxDockerfile(javaRecipe("RUN true"))),
    ]);
    expect(Date.parse(s.wsBuildState(OTHER).startedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(s.wsBuildState(WS).finishedAt ?? ""));
  });
});

describe("two graph-managers on one Docker daemon (review F5)", () => {
  const params = { ws: { id: "github~o~r", path: "/nonexistent" }, cwd: "/nonexistent", args: [], runId: "r1", providers: [] } as unknown as StartParams;

  async function instance(f: FakeDocker, name: string): Promise<Sandboxes> {
    const config = testConfig(path.join(dir, name), { dockerSocket: f.socketPath });
    return new Sandboxes({ config, store: await DataStore.open(path.join(dir, name, "data")) });
  }

  const tagsOf = async (f: FakeDocker) => (await new DockerClient(f.socketPath).listImages("gm.sandbox-image")).flatMap((i) => i.RepoTags ?? []).sort();

  it("labels images and volumes with the instance, and neither instance removes the other's", async () => {
    const f = await fake();
    const a = await instance(f, "a");
    expect((await a.init()).available).toBe(true);
    const aId = a.instanceId();
    expect(aId).toMatch(/^[0-9a-f]{16}$/);
    expect(f.builds.every((b) => b.labels[INSTANCE_LABEL] === aId)).toBe(true);
    const aVolume = [...f.volumes.values()].find((v) => v.Name.startsWith("gm-clis-"));
    expect(aVolume?.Labels).toEqual({ "gm.clis": "1", [INSTANCE_LABEL]: aId });
    const aImage = a.defaultImage();

    // B: another data dir (another instance id) with another recipe, on the same daemon.
    const b = await instance(f, "b");
    expect(b.instanceId()).not.toBe(aId);
    await b.opts.store.update((d) => {
      d.sandboxRecipe = { ...defaultRecipe({}), extraLines: "RUN echo b" };
    });
    expect((await b.init()).available).toBe(true);
    const bImage = b.defaultImage();
    expect(bImage).not.toBe(aImage);
    // B's cleanup left A's image alone.
    expect(await tagsOf(f)).toEqual([cliImageTag(GM_VERSION), aImage, bImage].sort());

    // A changes its recipe: its cleanup removes its own old image only, not B's.
    await a.opts.store.update((d) => {
      d.sandboxRecipe = { ...defaultRecipe({}), extraLines: "RUN echo a2" };
    });
    await a.ensureImages();
    const a2 = a.defaultImage();
    expect(await tagsOf(f)).toEqual([cliImageTag(GM_VERSION), a2, bImage].sort());
  });

  it("refills a gm-clis volume removed after the build before a start, so the sandbox never mounts an empty one", async () => {
    const f = await fake();
    const s = await sandboxes(f);
    expect((await s.init()).available).toBe(true);
    const volume = s.clisMount()?.Source as string;
    const docker = new DockerClient(f.socketPath);
    await docker.removeVolume(volume);
    expect(await docker.inspectVolume(volume)).toBeUndefined();
    const fills = () => f.requests.filter((r) => r.path === "/containers/create" && /^gm-clis-fill-/.test(String((r.query as Record<string, string> | undefined)?.name ?? ""))).length;
    const before = fills();
    // The start fails later (the workspace path does not exist), after the volume check.
    await s.start(params).catch(() => undefined);
    expect(await docker.inspectVolume(volume)).toBeDefined();
    expect(fills()).toBe(before + 1);
    expect(s.clisMount()?.Source).toBe(volume);
  });

  it("answers 409 and rebuilds when the gm-clis volume and the CLI image are both gone", async () => {
    const f = await fake({ buildDelayMs: 500 });
    const s = await sandboxes(f);
    await s.init();
    await until("the build", () => s.buildState().state === "ready");
    const docker = new DockerClient(f.socketPath);
    await docker.removeVolume(s.clisMount()?.Source as string);
    await docker.removeImage(cliImageTag(GM_VERSION));
    const err = await s.start(params).catch((e: unknown) => e);
    expect((err as SandboxError).status).toBe(409);
    expect((err as SandboxError).message).toBe("the sandbox image is building; try again when it is ready");
    await until("the rebuild", () => s.buildState().state !== "building");
    expect(s.buildState().state).toBe("ready");
    expect(await docker.inspectImage(cliImageTag(GM_VERSION))).toBeDefined();
    expect(await docker.inspectVolume(s.clisMount()?.Source as string)).toBeDefined();
  });
});
