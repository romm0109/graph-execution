import { rename } from "node:fs/promises";

const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
/** How long a rename keeps retrying on Windows, in ms. */
const RETRY_FOR_MS = 10_000;

/**
 * `fs.rename(from, to)` that replaces `to`, the last step of an atomic write. On Windows the rename fails with EPERM,
 * EACCES or EBUSY while another process has `to` open, for example the web page's poll reading the state file, or an
 * antivirus scan: it is retried with a growing delay for up to 10 s, the way graceful-fs does. POSIX renames over an
 * open file, so there it is a plain rename.
 */
export async function renameReplacing(from: string, to: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const until = Date.now() + RETRY_FOR_MS;
  for (let delay = 10; ; delay = Math.min(delay * 2, 200)) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (platform !== "win32" || !RETRY_CODES.has(code) || Date.now() + delay > until) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
