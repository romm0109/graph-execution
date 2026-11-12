import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameReplacing } from "graph-execution/api";

/** The file in the data dir that keeps the generated password. */
export const PASSWORD_FILE = "password";

export interface ResolvedPassword {
  password: string;
  /** `env`: from `GM_PASSWORD`; `file`: from `<dataDir>/password`. */
  source: "env" | "file";
  file: string;
  /** True when this call generated the password and wrote the file. */
  created: boolean;
}

/**
 * The login password: `GM_PASSWORD` when set, else the content of `<dataDir>/password`, generated on first start.
 * The file is private (mode 600) and written atomically.
 */
export async function resolvePassword(env: NodeJS.ProcessEnv, dataDir: string): Promise<ResolvedPassword> {
  const file = path.join(dataDir, PASSWORD_FILE);
  const fromEnv = env.GM_PASSWORD;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return { password: fromEnv, source: "env", file, created: false };

  const saved = await readSaved(file);
  if (saved !== "") return { password: saved, source: "file", file, created: false };

  const generated = randomBytes(24).toString("base64url");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // A name of its own, so two managers started at the same moment do not write through each other's temp file.
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${generated}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await renameReplacing(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  // Read back: when another start replaced the file in between, both use the password the file ends up with.
  const password = (await readSaved(file)) || generated;
  return { password, source: "file", file, created: password === generated };
}

/** The saved password, "" when the file is missing or blank. Tightens the mode of a file that was created by hand. */
async function readSaved(file: string): Promise<string> {
  let saved: string;
  try {
    saved = (await readFile(file, "utf8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
  // Best-effort: a file restored from a backup with mode 644 must not stay readable by other users.
  if (saved !== "") await chmod(file, 0o600).catch(() => undefined);
  return saved;
}
