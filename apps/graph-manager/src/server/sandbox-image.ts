// The images graph-manager builds for sandboxes (docs/prd/sandbox-image.md). The provider CLIs image
// `gm-sandbox-clis:<graph-manager version>` installs claude, codex, opencode and qwen with `npm install -g` inside
// Docker, so npm picks the Linux builds for the daemon's CPU. Its `/opt/gm-clis` is copied into the named volume
// `gm-clis-<id12>`, which every sandbox container mounts read-only at /opt/gm-clis. The default sandbox image
// `gm-sandbox:<hash of its Dockerfile>` is built from a recipe (base image, apt packages, extra Dockerfile lines) kept
// in graph-manager.json and edited in Settings → Sandbox.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { DockerClient } from "./docker.js";
import { tarArchive } from "./tar.js";

/** The repository of the provider CLIs image. */
export const CLI_IMAGE_REPO = "gm-sandbox-clis";
/** The repository of the default sandbox image. */
export const SANDBOX_IMAGE_REPO = "gm-sandbox";
/** Where a sandbox container (and the CLIs image) has the provider CLIs. */
export const CLIS_TARGET = "/opt/gm-clis";
/** The label (value "1") on every image graph-manager builds. */
export const IMAGE_LABEL = "gm.sandbox-image";
/** The label (value "1") on the gm-clis volumes. */
export const CLIS_LABEL = "gm.clis";
/** The npm packages of the provider CLIs. */
export const CLI_PACKAGES = ["@anthropic-ai/claude-code", "@openai/codex", "@opencode/cli", "@qwen-code/qwen-code"];

/** The Dockerfile of the provider CLIs image. */
export function cliDockerfile(): string {
  return [
    "FROM node:24.22.1-bookworm-slim",
    `RUN npm install -g --prefix ${CLIS_TARGET} --no-audit --no-fund ${CLI_PACKAGES.join(" ")} \\`,
    ` && ${CLIS_TARGET}/bin/claude --version && ${CLIS_TARGET}/bin/codex --version`,
  ].join("\n");
}

export function cliImageTag(gmVersion: string): string {
  return `${CLI_IMAGE_REPO}:${gmVersion}`;
}

/** The volume of the CLIs of the image `imageId`: `gm-clis-<first 12 hex of the id>`. */
export function clisVolumeName(imageId: string): string {
  return `gm-clis-${imageId.replace(/^sha256:/, "").slice(0, 12)}`;
}

/** A build context holding only the Dockerfile. */
export function dockerContext(dockerfile: string): Buffer {
  return tarArchive([{ path: "Dockerfile", content: Buffer.from(dockerfile) }], { uid: 0, gid: 0 });
}

/** Builds the CLIs image when it is missing (or always with `force`, without the build cache); its tag and id. */
export async function ensureCliImage(
  docker: DockerClient,
  gmVersion: string,
  opts: { force?: boolean; onLine?: (l: string) => void } = {},
): Promise<{ tag: string; id: string }> {
  const tag = cliImageTag(gmVersion);
  if (opts.force || !(await docker.inspectImage(tag))) {
    await docker.buildImage(tag, dockerContext(cliDockerfile()), {
      nocache: !!opts.force,
      labels: { [IMAGE_LABEL]: "1" },
      ...(opts.onLine ? { onLine: opts.onLine } : {}),
    });
  }
  const info = await docker.inspectImage(tag);
  if (!info) throw new Error("the CLI image was built but cannot be inspected");
  return { tag, id: info.Id };
}

/**
 * Makes sure the volume of the image's CLIs exists and is filled; returns its name. The volume is filled by mounting
 * it in a passive container of the image: Docker copies the image's /opt/gm-clis into it when it is empty (so no
 * `nocopy` here). An existing volume gets the container too: one left empty by a graph-manager stopped between the
 * create and the fill is filled then; a filled one is left as it is.
 */
export async function ensureClisVolume(docker: DockerClient, image: { tag: string; id: string }): Promise<string> {
  const name = clisVolumeName(image.id);
  const existed = (await docker.inspectVolume(name)) !== undefined;
  if (!existed) await docker.createVolume(name, { [CLIS_LABEL]: "1" });
  let code: number;
  try {
    let id: string | undefined;
    try {
      id = await docker.createContainer(`gm-clis-fill-${randomBytes(4).toString("hex")}`, {
        Image: image.tag,
        Cmd: ["true"],
        Labels: { "gm.clis-fill": "1" },
        HostConfig: { Mounts: [{ Type: "volume", Source: name, Target: CLIS_TARGET }] },
      });
      await docker.startContainer(id);
      code = await docker.waitContainer(id);
    } finally {
      if (id) await docker.removeContainer(id).catch(() => undefined);
    }
  } catch (err) {
    if (!existed) await docker.removeVolume(name).catch(() => undefined);
    throw err;
  }
  if (code !== 0) {
    if (!existed) await docker.removeVolume(name);
    throw new Error(`filling ${name} failed (exit ${code})`);
  }
  return name;
}

/** A Docker image reference: `name[:tag][@digest]`, optionally with a registry and path. */
export const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._\-/:@]{0,254}$/i;

/** The recipe of the default sandbox image. */
export interface SandboxRecipe {
  /** The base image (`FROM`). */
  base: string;
  /** Debian packages installed with apt-get. */
  packages: string[];
  /** Dockerfile lines after the packages (no `FROM`). */
  extraLines: string;
}

/** The recipe when none is saved: Node, plus Python, Java, Go, Rust, Ruby, PHP, C/C++ and pnpm/yarn (corepack). */
export const DEFAULT_RECIPE: SandboxRecipe = {
  base: "node:24.22.1-bookworm",
  packages: [
    "python3",
    "python3-pip",
    "python3-venv",
    "pipx",
    "default-jdk-headless",
    "maven",
    "gradle",
    "ruby-full",
    "php-cli",
    "composer",
    "build-essential",
    "pkg-config",
    "cmake",
    "ripgrep",
    "jq",
    "zip",
    "unzip",
    "sqlite3",
  ],
  extraLines: [
    "COPY --from=golang:1-bookworm /usr/local/go /usr/local/go",
    "COPY --from=rust:1-bookworm /usr/local/cargo /usr/local/cargo",
    "COPY --from=rust:1-bookworm /usr/local/rustup /usr/local/rustup",
    "ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/go/bin:/usr/local/cargo/bin:$PATH",
    "RUN chmod -R a+rwX /usr/local/cargo /usr/local/rustup && corepack enable",
  ].join("\n"),
};

/** The recipe body of the settings route and the store. */
export const recipeSchema = z
  .object({
    base: z.string().trim().max(255),
    packages: z.array(z.string().trim().max(200)).max(1000),
    extraLines: z.string().max(20000),
  })
  .strict();

const PACKAGE_PATTERN = /^[a-z0-9][a-z0-9.+-]*(=[A-Za-z0-9.+~:-]+)?$/;

/** The default recipe, with `GM_SANDBOX_IMAGE` (config.sandboxImage) as its base when set. */
export function defaultRecipe(config: { sandboxImage?: string }): SandboxRecipe {
  return { ...DEFAULT_RECIPE, packages: [...DEFAULT_RECIPE.packages], ...(config.sandboxImage ? { base: config.sandboxImage } : {}) };
}

/** The packages trimmed, without empty ones and duplicates, sorted. */
export function normalizePackages(packages: string[]): string[] {
  return [...new Set(packages.map((p) => p.trim()).filter((p) => p !== ""))].sort();
}

/** The recipe with its base trimmed and its packages normalised. */
export function normalizeRecipe(r: SandboxRecipe): SandboxRecipe {
  return { base: r.base.trim(), packages: normalizePackages(r.packages), extraLines: r.extraLines };
}

/** The Dockerfile of a recipe: FROM, one apt-get RUN (when there are packages), then the extra lines. */
export function sandboxDockerfile(r: SandboxRecipe): string {
  const lines = [`FROM ${r.base.trim()}`];
  const packages = normalizePackages(r.packages);
  if (packages.length > 0) {
    lines.push(`RUN apt-get update && apt-get install -y --no-install-recommends ${packages.join(" ")} && rm -rf /var/lib/apt/lists/*`);
  }
  for (const line of r.extraLines.split(/\r?\n/)) {
    const t = line.trim();
    if (t !== "") lines.push(t);
  }
  return `${lines.join("\n")}\n`;
}

/** `gm-sandbox:<first 12 hex of sha256(dockerfile)>`. */
export function sandboxImageTag(dockerfile: string): string {
  return `${SANDBOX_IMAGE_REPO}:${createHash("sha256").update(dockerfile).digest("hex").slice(0, 12)}`;
}

/** The 400 message for an invalid recipe, or undefined when it is valid. */
export function validateRecipe(r: SandboxRecipe): string | undefined {
  if (!IMAGE_PATTERN.test(r.base.trim())) return "base: not a valid image reference";
  const packages = r.packages.map((p) => p.trim()).filter((p) => p !== "");
  for (const p of packages) if (!PACKAGE_PATTERN.test(p)) return `packages: ${p} is not a Debian package name`;
  if (packages.length > 200) return "packages: at most 200";
  if (r.extraLines.length > 20000) return "extraLines: at most 20000 characters";
  for (const line of r.extraLines.split(/\r?\n/)) {
    if (/^from$/i.test(line.trim().split(/\s+/)[0] ?? "")) return "extraLines: FROM is not allowed; use COPY --from=<image>";
  }
  return undefined;
}

/** Builds the sandbox image of a recipe when it is missing (or always with `force`, without the build cache); its tag and id. */
export async function ensureSandboxImage(
  docker: DockerClient,
  recipe: SandboxRecipe,
  opts: { force?: boolean; onLine?: (l: string) => void } = {},
): Promise<{ tag: string; id: string }> {
  const dockerfile = sandboxDockerfile(recipe);
  const tag = sandboxImageTag(dockerfile);
  if (opts.force || !(await docker.inspectImage(tag))) {
    await docker.buildImage(tag, dockerContext(dockerfile), {
      nocache: !!opts.force,
      labels: { [IMAGE_LABEL]: "1" },
      ...(opts.onLine ? { onLine: opts.onLine } : {}),
    });
  }
  const info = await docker.inspectImage(tag);
  if (!info) throw new Error("the sandbox image was built but cannot be inspected");
  return { tag, id: info.Id };
}

/**
 * Removes the images graph-manager built, except `keepIds`; Docker keeps those a container uses (409). Each gm-sandbox
 * tag is removed by name, so an image the user also tagged otherwise keeps that tag (removing by id would fail).
 */
export async function removeOldImages(docker: DockerClient, keepIds: string[]): Promise<void> {
  const ours = (t: string): boolean => t.startsWith(`${CLI_IMAGE_REPO}:`) || t.startsWith(`${SANDBOX_IMAGE_REPO}:`);
  for (const img of await docker.listImages(IMAGE_LABEL)) {
    if (keepIds.includes(img.Id)) continue;
    const tags = (img.RepoTags ?? []).filter((t) => t !== "<none>:<none>");
    if (tags.length === 0) await docker.removeImage(img.Id);
    else for (const t of tags.filter(ours)) await docker.removeImage(t);
  }
}
