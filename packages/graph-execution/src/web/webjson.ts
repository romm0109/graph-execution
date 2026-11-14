import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * `web.json` in a run folder: `{ url, pid, host }` while the run process lives. `host`: `os.hostname()` of the
 * process that wrote it (a container id inside a graph-manager sandbox); missing in files written before it.
 */
export const webJsonPath = (runDir: string): string => path.join(runDir, "web.json");

export const webJsonSchema = z.object({ url: z.string(), pid: z.number(), host: z.string().optional() });
export type WebJson = z.infer<typeof webJsonSchema>;

/** The `{ url, pid }` the run process wrote; undefined when the file is missing or invalid. */
export async function readWebJson(runDir: string): Promise<WebJson | undefined> {
  try {
    return webJsonSchema.parse(JSON.parse(await readFile(webJsonPath(runDir), "utf8")));
  } catch {
    return undefined;
  }
}
