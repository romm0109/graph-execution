import { execFile } from "node:child_process";
import path from "node:path";

/** Runs `file args`; resolves its stdout, rejects on error or timeout. */
export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<string>;

export const FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "~/.local/bin"];

const MARKER = "__GM_PATH__";
const TIMEOUT_MS = 5000;

const defaultExec: Exec = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/**
 * The PATH to use: the login shell's on macOS, else `env.PATH`; on failure, `env.PATH` plus the fallback dirs. Apps
 * started from the Finder or the Dock get launchd's minimal PATH, without Homebrew's or the user's bin dirs.
 */
export async function resolvePath(opts: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exec?: Exec;
  log?: (msg: string) => void;
}): Promise<string | undefined> {
  const { platform, env, home, exec = defaultExec, log = () => {} } = opts;
  if (platform !== "darwin") return env.PATH;
  let reason: string;
  try {
    const out = await exec(env.SHELL || "/bin/zsh", ["-ilc", `printf "\\n${MARKER}%s\\n" "$PATH"`], TIMEOUT_MS);
    const line = out.split(/\r?\n/).find((l) => l.startsWith(MARKER));
    const found = line?.slice(MARKER.length).trim();
    if (found) return found;
    reason = "no PATH in the shell's output";
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
  log(`shell PATH failed: ${reason}`);
  const dirs = (env.PATH ?? "").split(":").filter(Boolean);
  for (const d of FALLBACK_DIRS) {
    const full = d.startsWith("~/") ? path.posix.join(home, d.slice(2)) : d;
    if (!dirs.includes(full)) dirs.push(full);
  }
  return dirs.join(":");
}
