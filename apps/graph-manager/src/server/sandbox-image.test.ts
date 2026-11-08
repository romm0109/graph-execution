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
  removeOldImages,
  type SandboxRecipe,
  sandboxDockerfile,
  sandboxImageTag,
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

describe("sandboxDockerfile", () => {
  it("writes FROM, one apt-get line with the sorted packages, then the extra lines", () => {
    const d = sandboxDockerfile(DEFAULT_RECIPE);
    expect(
      d.startsWith(
        "FROM node:24.22.1-bookworm\n" +
          "RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake composer default-jdk-headless gradle jq maven php-cli pipx pkg-config python3 python3-pip python3-venv ripgrep ruby-full sqlite3 unzip zip && rm -rf /var/lib/apt/lists/*\n" +
          "COPY --from=golang:1-bookworm",
      ),
    ).toBe(true);
    expect(d.endsWith("corepack enable\n")).toBe(true);
    expect(sandboxDockerfile({ base: " debian:12 ", packages: [" ", ""], extraLines: "\n  RUN true  \n\n" })).toBe("FROM debian:12\nRUN true\n");
    expect(sandboxDockerfile({ base: "debian:12", packages: ["jq", " jq", "curl"], extraLines: "" })).toContain("--no-install-recommends curl jq &&");
  });

  it("tags by the Dockerfile's hash", () => {
    const tag = sandboxImageTag(sandboxDockerfile(DEFAULT_RECIPE));
    expect(tag).toMatch(/^gm-sandbox:[0-9a-f]{12}$/);
    expect(sandboxImageTag(sandboxDockerfile({ ...DEFAULT_RECIPE, packages: [...DEFAULT_RECIPE.packages] }))).toBe(tag);
    expect(sandboxImageTag(sandboxDockerfile({ ...DEFAULT_RECIPE, packages: [...DEFAULT_RECIPE.packages, "htop"] }))).not.toBe(tag);
  });

  it("uses GM_SANDBOX_IMAGE as the default recipe's base", () => {
    expect(defaultRecipe({ sandboxImage: "debian:12" }).base).toBe("debian:12");
    expect(defaultRecipe({})).toEqual(DEFAULT_RECIPE);
  });
});

describe("validateRecipe", () => {
  const ok = { base: "node:22", packages: ["jq", "libssl-dev=3.0.11-1~deb12u2"], extraLines: "RUN true" };
  it("accepts a valid recipe and the default", () => {
    expect(validateRecipe(ok)).toBeUndefined();
    expect(validateRecipe(DEFAULT_RECIPE)).toBeUndefined();
  });
  it("answers the message of the first problem", () => {
    const fromMsg = "extraLines: FROM is not allowed; use COPY --from=<image>";
    expect(validateRecipe({ ...ok, extraLines: "RUN true\nFROM ubuntu" })).toBe(fromMsg);
    expect(validateRecipe({ ...ok, extraLines: "  from ubuntu" })).toBe(fromMsg);
    expect(validateRecipe({ ...ok, extraLines: "COPY --from=ubuntu /a /a" })).toBeUndefined();
    expect(validateRecipe({ ...ok, packages: ["Python3!"] })).toBe("packages: Python3! is not a Debian package name");
    expect(validateRecipe({ ...ok, base: "bad image!" })).toBe("base: not a valid image reference");
    expect(validateRecipe({ ...ok, packages: Array.from({ length: 201 }, (_, i) => `p${i}`) })).toBe("packages: at most 200");
    expect(validateRecipe({ ...ok, extraLines: "x".repeat(20001) })).toBe("extraLines: at most 20000 characters");
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
    expect(await s.status()).toEqual({ available: false, building: true, reason: "building the sandbox image" });

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
    expect(f.builds.map((b) => ({ tag: b.tag, nocache: b.nocache, labels: b.labels }))).toEqual([
      { tag: cliImageTag(GM_VERSION), nocache: false, labels: { "gm.sandbox-image": "1" } },
      { tag: DEFAULT_TAG, nocache: false, labels: { "gm.sandbox-image": "1" } },
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
    const recipe: SandboxRecipe = { ...DEFAULT_RECIPE, packages: [...DEFAULT_RECIPE.packages, "htop"] };
    await s.opts.store.update((d) => {
      d.sandboxRecipe = recipe;
    });
    await s.ensureImages();
    const tag = sandboxImageTag(sandboxDockerfile(recipe));
    expect(f.builds).toHaveLength(3);
    expect(f.builds[2]).toMatchObject({ tag, nocache: false });
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
      d.sandboxRecipe = { ...DEFAULT_RECIPE, packages: ["jq"] };
    });
    await s.ensureImages();
    expect(s.buildState().state).toBe("ready");
    const tags = (await docker.listImages("gm.sandbox-image")).flatMap((i) => i.RepoTags ?? []);
    expect(tags).toContain(DEFAULT_TAG);
    expect(tags).toContain(s.defaultImage());
    expect(tags).toHaveLength(3);
  });

  it("removes other gm-clis volumes", async () => {
    const f = await fake();
    const docker = new DockerClient(f.socketPath);
    await docker.createVolume("gm-clis-000000000000", { "gm.clis": "1" });
    const s = await sandboxes(f);
    expect((await s.init()).available).toBe(true);
    const names = [...f.volumes.keys()].filter((n) => n.startsWith("gm-clis-"));
    expect(names).toEqual([s.clisMount()?.Source]);
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
