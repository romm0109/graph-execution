import type http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ASSETS_DIR = fileURLToPath(new URL("./assets/", import.meta.url));
const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".txt": "text/plain; charset=utf-8",
};

/** Serves GET /assets/<path> from `root`; false when it is not a servable asset (the caller answers 404). */
export async function serveAsset(root: string, pathname: string, res: http.ServerResponse): Promise<boolean> {
  if (!pathname.startsWith("/assets/")) return false;
  let rel: string;
  try { rel = decodeURIComponent(pathname.slice("/assets/".length)); } catch { return false; }
  const base = path.resolve(root);
  const file = path.resolve(base, rel);
  const type = TYPES[path.extname(file)];
  if (!type || !file.startsWith(base + path.sep)) return false;
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" }).end(body);
    return true;
  } catch { return false; }
}
