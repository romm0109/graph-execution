// The Dockerfile of the standalone sandbox image: the bundled template filled with the base image, the CLI packages
// of the run's providers and the extra lines from the config and the run flags.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PROVIDER_CATALOG } from "../providers/catalog.js";

/** A Docker image reference: `name[:tag][@digest]`, optionally with a registry and path (graph-manager's IMAGE_PATTERN). */
export const IMAGE = /^[a-z0-9][a-z0-9._\-/:@]{0,254}$/i;

/** The default base image (`FROM`) of the sandbox image. */
export const DEFAULT_SANDBOX_BASE = "node:24.22.1-bookworm";

/** The repository of the generated images; the tag is a hash of the Dockerfile. */
export const SANDBOX_IMAGE_REPO = "graph-execution-sandbox";

export const FROM_ERROR = "FROM is not allowed in sandbox Dockerfile lines; use COPY --from=<image>";

/** True when a line of `text` starts with the word FROM (any case). */
export function hasFromLine(text: string): boolean {
  return text.split(/\r?\n/).some((line) => /^from$/i.test(line.trim().split(/\s+/)[0] ?? ""));
}

/** The settings the image is made from (see settings.ts). */
export interface ImageSettings {
  /** A ready-made image: no build. */
  image?: string;
  base: string;
  lines: string[];
}

export type ResolvedImage = { kind: "ready"; image: string } | { kind: "build"; dockerfile: string; tag: string };

/** The bundled template, at the package root: `../../sandbox/` from both `src/sandbox/` and `dist/sandbox/`. */
export function readTemplate(): string {
  return readFileSync(new URL("../../sandbox/Dockerfile.template", import.meta.url), "utf8");
}

/**
 * The npm packages of the providers' CLIs, in catalog order: `bun` too when `omp` is among them. `fake` and unknown ids
 * add nothing. With no provider, every catalog package and `bun`.
 */
export function sandboxPackages(providers: readonly string[] = []): string[] {
  const all = providers.length === 0;
  const pkgs = PROVIDER_CATALOG.filter((p) => all || providers.includes(p.id)).map((p) => p.npmPackage);
  if (all || providers.includes("omp")) pkgs.push("bun");
  return [...new Set(pkgs)];
}

/** The lines without carriage returns and without trailing blank lines; the rest is kept verbatim. */
function cleanLines(lines: readonly string[]): string[] {
  const out = lines.map((l) => l.replace(/\r/g, ""));
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out;
}

/** The generated Dockerfile. Throws when a line is a FROM line. */
export function sandboxDockerfile(settings: Pick<ImageSettings, "base" | "lines">, providers: readonly string[] = [], template = readTemplate()): string {
  if (settings.lines.some(hasFromLine)) throw new Error(FROM_ERROR);
  const pkgs = sandboxPackages(providers);
  const lines = cleanLines(settings.lines).join("\n");
  let text = template
    .replace(/\r/g, "")
    .replace("{{base}}", () => settings.base.trim())
    .replace("{{lines}}", () => lines);
  // No package (only `fake`): drop the install line rather than run `npm install -g` with nothing.
  text = pkgs.length > 0 ? text.replace("{{packages}}", () => pkgs.join(" ")) : text.replace(/^.*\{\{packages\}\}.*\n/m, "");
  return `${text.replace(/\n+$/, "")}\n`;
}

/** `graph-execution-sandbox:<first 12 hex of sha256(dockerfile)>`. */
export function sandboxImageTag(dockerfile: string): string {
  return `${SANDBOX_IMAGE_REPO}:${createHash("sha256").update(dockerfile).digest("hex").slice(0, 12)}`;
}

/** A ready-made image as is, else the Dockerfile to build and its tag. */
export function resolveImage(settings: ImageSettings, providers: readonly string[] = []): ResolvedImage {
  if (settings.image) return { kind: "ready", image: settings.image };
  const dockerfile = sandboxDockerfile(settings, providers);
  return { kind: "build", dockerfile, tag: sandboxImageTag(dockerfile) };
}
