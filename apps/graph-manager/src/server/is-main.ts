import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether the module at `metaUrl` (its `import.meta.url`) is the file node was started with. Node gives the main
 * module the URL of its real path, while `argv[1]` keeps the path as it was typed, so the real paths are compared:
 * a checkout reached through a symlinked folder still counts as run directly.
 */
export function isMain(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
