// Whether a run started with `--sandbox` is still running: its lock was written inside the container (another host),
// so the lock's pid means nothing here; the container's state says it instead. Kept free of the run start's imports
// so the cleanup and preflight modules can use it.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type DockerOptions, inspect } from "./docker.js";

/** `<runDir>/sandbox.json`: written by the host when a sandboxed run's page is up. */
export const SANDBOX_FILE = "sandbox.json";

export const sandboxRecordSchema = z.object({
  /** The container's name, `ge-sbx-<run id>`. */
  container: z.string(),
  image: z.string(),
  /** The container's hostname (its run lock's host). */
  hostname: z.string(),
  /** The page on the host, without the token. */
  url: z.string(),
  token: z.string(),
  /** The host that started the container. */
  host: z.string(),
});
export type SandboxRecord = z.infer<typeof sandboxRecordSchema>;

/** The run's sandbox.json, or undefined when it has none (or it is unreadable). */
export async function readSandboxRecord(runDir: string): Promise<SandboxRecord | undefined> {
  const text = await readFile(path.join(runDir, SANDBOX_FILE), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const parsed = sandboxRecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The page URL with its token, as the user opens it. */
export const sandboxPageUrl = (record: SandboxRecord): string => `${record.url}?token=${encodeURIComponent(record.token)}`;

export interface SandboxLiveness {
  record: SandboxRecord;
  /** `running`, `exited` (any stopped state), `missing` (no such container) or `unknown` (docker cannot tell). */
  state: "running" | "exited" | "missing" | "unknown";
  /** True when running, and when unknown: a run that may be live is never treated as stopped. */
  live: boolean;
}

/** The liveness of a sandboxed run, or undefined when the run has no sandbox.json (not started with `--sandbox`). */
export async function sandboxLiveness(runDir: string, docker: DockerOptions = {}): Promise<SandboxLiveness | undefined> {
  const record = await readSandboxRecord(runDir);
  if (!record) return undefined;
  let state: SandboxLiveness["state"];
  try {
    const s = await inspect(record.container, docker);
    state = s === undefined ? "missing" : s.running ? "running" : "exited";
  } catch {
    state = "unknown";
  }
  return { record, state, live: state === "running" || state === "unknown" };
}
