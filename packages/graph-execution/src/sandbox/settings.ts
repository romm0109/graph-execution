// The sandbox settings of one run: the run flags over the config's `sandbox` section over the defaults.
import { type Config, sandboxConfigSchema } from "../config/config.js";
import { UsageError } from "../launch/preflight.js";
import { FROM_ERROR, hasFromLine } from "./image.js";

export interface SandboxSettings {
  /** A ready-made image: no build. */
  image?: string;
  base: string;
  lines: string[];
  cpus: number;
  memoryMb: number;
  pids: number;
  env: string[];
}

/** The run flags that change the sandbox (commander's names). */
export interface SandboxFlags {
  sandbox?: boolean;
  sandboxImage?: string;
  sandboxBase?: string;
  /** `--sandbox-line`, repeatable. */
  sandboxLine?: string[];
  /** commander's `--no-sandbox-config-lines`: false drops the config's lines. */
  sandboxConfigLines?: boolean;
  sandboxCpus?: number;
  sandboxMemory?: number;
  sandboxPids?: number;
}

/** The image flags, in the order the error names the first one given. */
const IMAGE_FLAGS: [keyof SandboxFlags, string][] = [
  ["sandboxImage", "--sandbox-image"],
  ["sandboxBase", "--sandbox-base"],
  ["sandboxLine", "--sandbox-line"],
  ["sandboxConfigLines", "--no-sandbox-config-lines"],
  ["sandboxCpus", "--sandbox-cpus"],
  ["sandboxMemory", "--sandbox-memory"],
  ["sandboxPids", "--sandbox-pids"],
];

function given(flags: SandboxFlags, key: keyof SandboxFlags): boolean {
  const v = flags[key];
  if (key === "sandboxLine") return Array.isArray(v) && v.length > 0;
  if (key === "sandboxConfigLines") return v === false;
  return v !== undefined;
}

/** The first image flag given, e.g. `--sandbox-base`, or undefined. */
export function firstSandboxFlag(flags: SandboxFlags): string | undefined {
  return IMAGE_FLAGS.find(([key]) => given(flags, key))?.[1];
}

/**
 * Checks the flags only: a ready-made image with Dockerfile flags, image flags without `--sandbox` (unless
 * `requireSandbox` is false, for the `sandbox` commands) and FROM lines. Throws UsageError.
 */
export function checkSandboxFlags(flags: SandboxFlags, requireSandbox = true): void {
  if (flags.sandboxImage !== undefined && (flags.sandboxBase !== undefined || given(flags, "sandboxLine"))) {
    throw new UsageError("--sandbox-image is a ready-made image; it cannot be combined with --sandbox-base or --sandbox-line");
  }
  const first = firstSandboxFlag(flags);
  if (requireSandbox && !flags.sandbox && first) throw new UsageError(`${first} needs --sandbox`);
  if ((flags.sandboxLine ?? []).some(hasFromLine)) throw new UsageError(FROM_ERROR);
}

/** The run's sandbox settings: flags, then the config's `sandbox` section, then the defaults. */
export function resolveSandboxSettings(config: Pick<Config, "sandbox">, flags: SandboxFlags, requireSandbox = true): SandboxSettings {
  checkSandboxFlags(flags, requireSandbox);
  const cfg = config.sandbox ?? sandboxConfigSchema().parse({});
  const configLines = flags.sandboxConfigLines === false ? [] : cfg.dockerfile;
  const lines = [...configLines, ...(flags.sandboxLine ?? [])];
  if (lines.some(hasFromLine)) throw new UsageError(FROM_ERROR);
  // A ready-made image from the flags wins over the config's lines and base; one from the config is dropped when the
  // flags ask for a Dockerfile of their own.
  const image = flags.sandboxImage ?? (flags.sandboxBase !== undefined || given(flags, "sandboxLine") ? undefined : cfg.image);
  return {
    ...(image !== undefined ? { image } : {}),
    base: flags.sandboxBase ?? cfg.base,
    lines,
    cpus: flags.sandboxCpus ?? cfg.cpus,
    memoryMb: flags.sandboxMemory ?? cfg.memoryMb,
    pids: flags.sandboxPids ?? cfg.pids,
    env: [...cfg.env],
  };
}
