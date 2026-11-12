// The images graph-manager builds for sandboxes (docs/prd/sandbox-image.md). The provider CLIs image
// `gm-sandbox-clis:<graph-manager version>` installs every provider CLI of the catalog (and Bun) with `npm install -g` inside
// Docker, so npm picks the Linux builds for the daemon's CPU. Its `/opt/gm-clis` is copied into the named volume
// `gm-clis-<id12>`, which every sandbox container mounts read-only at /opt/gm-clis. The default sandbox image
// `gm-sandbox:<hash of its Dockerfile>` is built from a recipe kept in graph-manager.json and edited in Settings → Sandbox:
// a base image, the 7 built-in toolchains (Python, Java, Go, Rust, Ruby, PHP, C/C++; each opt-in, with an editable
// snippet, in an editable order) and extra Dockerfile lines. Snippets and extra lines are kept verbatim. The default is
// Node only (`FROM node:24.22.1-bookworm`).
import { createHash, randomBytes } from "node:crypto";
import { SANDBOX_CLI_PACKAGES } from "graph-execution/api";
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
/**
 * The label naming the graph-manager instance (its `instanceId` in graph-manager.json) that built an image or made a
 * gm-clis volume. Cleanup only removes its own, so two graph-managers on one Docker daemon leave each other's alone.
 */
export const INSTANCE_LABEL = "gm.instance";

/** The labels of an image or volume made by `instance`: the kind label, plus the instance label when one is given. */
function labelsOf(kind: string, instance?: string): Record<string, string> {
  return instance ? { [kind]: "1", [INSTANCE_LABEL]: instance } : { [kind]: "1" };
}
/** The npm packages of the provider CLIs (every catalog entry), then Bun, which omp runs on. */
export const CLI_PACKAGES: readonly string[] = SANDBOX_CLI_PACKAGES;

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
  opts: { force?: boolean; onLine?: (l: string) => void; instance?: string } = {},
): Promise<{ tag: string; id: string }> {
  const tag = cliImageTag(gmVersion);
  if (opts.force || !(await docker.inspectImage(tag))) {
    await docker.buildImage(tag, dockerContext(cliDockerfile()), {
      nocache: !!opts.force,
      labels: labelsOf(IMAGE_LABEL, opts.instance),
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
export async function ensureClisVolume(docker: DockerClient, image: { tag: string; id: string }, instance?: string): Promise<string> {
  const name = clisVolumeName(image.id);
  const existed = (await docker.inspectVolume(name)) !== undefined;
  if (!existed) await docker.createVolume(name, labelsOf(CLIS_LABEL, instance));
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

export type ToolchainId = "python" | "java" | "go" | "rust" | "ruby" | "php" | "cpp";
/** The ids of the built-in toolchains, in the default order. */
export const TOOLCHAIN_IDS: ToolchainId[] = ["python", "java", "go", "rust", "ruby", "php", "cpp"];

/** One apt-get RUN line installing `pkgs`. */
const apt = (pkgs: string): string => `RUN apt-get update && apt-get install -y --no-install-recommends ${pkgs} && rm -rf /var/lib/apt/lists/*`;

/** The built-in toolchains, in the default order, with their default snippets. */
export const TOOLCHAINS: { id: ToolchainId; name: string; snippet: string }[] = [
  { id: "python", name: "Python", snippet: apt("python3 python3-pip python3-venv pipx") },
  { id: "java", name: "Java", snippet: apt("default-jdk-headless maven gradle") },
  { id: "go", name: "Go", snippet: "COPY --from=golang:1-bookworm /usr/local/go /usr/local/go\nENV PATH=/usr/local/go/bin:$PATH" },
  {
    id: "rust",
    name: "Rust",
    snippet: [
      "COPY --from=rust:1-bookworm /usr/local/cargo /usr/local/cargo",
      "COPY --from=rust:1-bookworm /usr/local/rustup /usr/local/rustup",
      "ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH",
      "RUN chmod -R a+rwX /usr/local/cargo /usr/local/rustup",
    ].join("\n"),
  },
  { id: "ruby", name: "Ruby", snippet: apt("ruby-full") },
  { id: "php", name: "PHP", snippet: apt("php-cli composer") },
  { id: "cpp", name: "C/C++", snippet: apt("build-essential pkg-config cmake") },
];

/** A toolchain of a recipe: its snippet goes into the Dockerfile when it is enabled. */
export interface RecipeToolchain {
  id: ToolchainId;
  enabled: boolean;
  /** Dockerfile lines (no `FROM`), kept verbatim. */
  snippet: string;
}

/** The recipe of the default sandbox image. */
export interface SandboxRecipe {
  /** The base image (`FROM`). */
  base: string;
  /** All 7 built-in toolchains; the array order is the Dockerfile order. */
  toolchains: RecipeToolchain[];
  /** Dockerfile lines after the toolchains (no `FROM`), kept verbatim. */
  extraLines: string;
}

/** The recipe when none is saved: Node only, every toolchain disabled with its default snippet. */
export const DEFAULT_RECIPE: SandboxRecipe = {
  base: "node:24.22.1-bookworm",
  toolchains: TOOLCHAINS.map((t) => ({ id: t.id, enabled: false, snippet: t.snippet })),
  extraLines: "",
};

const toolchainSchema = z
  .object({ id: z.enum(["python", "java", "go", "rust", "ruby", "php", "cpp"]), enabled: z.boolean(), snippet: z.string().max(20000) })
  .strict();

/** The recipe body of the settings route and the store. */
export const recipeSchema = z
  .object({
    base: z.string().trim().max(255),
    toolchains: z.array(toolchainSchema).max(7),
    extraLines: z.string().max(20000),
  })
  .strict();

/** The default toolchains: a fresh copy, all disabled, with their default snippets. */
function defaultToolchains(): RecipeToolchain[] {
  return DEFAULT_RECIPE.toolchains.map((t) => ({ id: t.id, enabled: t.enabled, snippet: t.snippet }));
}

/** A deep copy of the default recipe, with `GM_SANDBOX_IMAGE` (config.sandboxImage) as its base when set. */
export function defaultRecipe(config: { sandboxImage?: string }): SandboxRecipe {
  return { base: config.sandboxImage || DEFAULT_RECIPE.base, toolchains: defaultToolchains(), extraLines: DEFAULT_RECIPE.extraLines };
}

/**
 * A recipe in the old shape `{ base, packages, extraLines }` in the new one: all toolchains disabled, and the packages
 * as one apt-get line before the old extra lines. Anything else is returned unchanged (the schema judges it).
 */
export function migrateRecipe(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.packages) || "toolchains" in o) return raw;
  const packages = [...new Set(o.packages.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter((p) => p !== ""))].sort();
  const oldExtra = typeof o.extraLines === "string" ? o.extraLines : "";
  const extraLines = packages.length > 0 ? `${apt(packages.join(" "))}\n${oldExtra}` : oldExtra;
  return { base: o.base, toolchains: defaultToolchains(), extraLines };
}

/** The recipe with its base trimmed and the carriage returns dropped from its snippets and extra lines. */
export function normalizeRecipe(r: SandboxRecipe): SandboxRecipe {
  return {
    base: r.base.trim(),
    toolchains: r.toolchains.map((t) => ({ id: t.id, enabled: t.enabled, snippet: t.snippet.replace(/\r/g, "") })),
    extraLines: r.extraLines.replace(/\r/g, ""),
  };
}

/** The text without carriage returns and trailing newlines; the lines themselves are kept verbatim. */
const clean = (s: string): string => s.replace(/\r/g, "").replace(/\n+$/, "");

/** The Dockerfile of a recipe: FROM, then `# <name>` and the snippet of each enabled toolchain in order, then the extra lines. */
export function sandboxDockerfile(r: SandboxRecipe): string {
  const parts = [`FROM ${r.base.trim()}`];
  for (const t of r.toolchains) {
    if (!t.enabled) continue;
    const name = TOOLCHAINS.find((x) => x.id === t.id)?.name ?? t.id;
    parts.push(`# ${name}`);
    const s = clean(t.snippet);
    if (s.trim() !== "") parts.push(s);
  }
  const extra = clean(r.extraLines);
  if (extra.trim() !== "") parts.push(extra);
  return `${parts.join("\n")}\n`;
}

/** `gm-sandbox:<first 12 hex of sha256(dockerfile)>`. */
export function sandboxImageTag(dockerfile: string): string {
  return `${SANDBOX_IMAGE_REPO}:${createHash("sha256").update(dockerfile).digest("hex").slice(0, 12)}`;
}

const hasFrom = (text: string): boolean => text.split(/\r?\n/).some((line) => /^from$/i.test(line.trim().split(/\s+/)[0] ?? ""));
const FROM_ERROR = "FROM is not allowed; use COPY --from=<image>";

/** The 400 message for an invalid recipe, or undefined when it is valid. */
export function validateRecipe(r: SandboxRecipe): string | undefined {
  if (!IMAGE_PATTERN.test(r.base.trim())) return "base: not a valid image reference";
  const ids = r.toolchains.map((t) => t.id);
  if (ids.length !== TOOLCHAIN_IDS.length || new Set(ids).size !== ids.length || !TOOLCHAIN_IDS.every((id) => ids.includes(id))) {
    return `toolchains: must list each of ${TOOLCHAIN_IDS.join(", ")} exactly once`;
  }
  for (const t of r.toolchains) if (hasFrom(t.snippet)) return `toolchains.${t.id}: ${FROM_ERROR}`;
  if (hasFrom(r.extraLines)) return `extraLines: ${FROM_ERROR}`;
  if (r.extraLines.length > 20000) return "extraLines: at most 20000 characters";
  for (const t of r.toolchains) if (t.snippet.length > 20000) return `toolchains.${t.id}: at most 20000 characters`;
  return undefined;
}

/** Builds the sandbox image of a recipe when it is missing (or always with `force`, without the build cache); its tag and id. */
export async function ensureSandboxImage(
  docker: DockerClient,
  recipe: SandboxRecipe,
  opts: { force?: boolean; onLine?: (l: string) => void; instance?: string } = {},
): Promise<{ tag: string; id: string }> {
  const dockerfile = sandboxDockerfile(recipe);
  const tag = sandboxImageTag(dockerfile);
  if (opts.force || !(await docker.inspectImage(tag))) {
    await docker.buildImage(tag, dockerContext(dockerfile), {
      nocache: !!opts.force,
      labels: labelsOf(IMAGE_LABEL, opts.instance),
      ...(opts.onLine ? { onLine: opts.onLine } : {}),
    });
  }
  const info = await docker.inspectImage(tag);
  if (!info) throw new Error("the sandbox image was built but cannot be inspected");
  return { tag, id: info.Id };
}

/**
 * Removes the images graph-manager built, except `keepIds`; Docker keeps those a container uses (409). With `instance`,
 * only images labelled with that instance are removed (review F5: another graph-manager's images are left alone). Each gm-sandbox
 * tag is removed by name, so an image the user also tagged otherwise keeps that tag (removing by id would fail).
 */
export async function removeOldImages(docker: DockerClient, keepIds: string[], instance?: string): Promise<void> {
  const ours = (t: string): boolean => t.startsWith(`${CLI_IMAGE_REPO}:`) || t.startsWith(`${SANDBOX_IMAGE_REPO}:`);
  for (const img of await docker.listImages(IMAGE_LABEL)) {
    if (keepIds.includes(img.Id)) continue;
    // Another graph-manager's image, or one without the instance label (built before it existed): not ours to remove.
    if (instance !== undefined && img.Labels?.[INSTANCE_LABEL] !== instance) continue;
    const tags = (img.RepoTags ?? []).filter((t) => t !== "<none>:<none>");
    if (tags.length === 0) await docker.removeImage(img.Id);
    else for (const t of tags.filter(ours)) await docker.removeImage(t);
  }
}
