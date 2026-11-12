import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { engineDirOf } from "../sandbox-tools.js";

/** The version in the engine package's package.json, or null when `bin` is not a graph-execution package's cli.js. */
export function engineVersion(bin: string): string | null {
  const dir = engineDirOf(bin);
  if (!dir) return null;
  try {
    const version = (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Authenticated: the engine the terminals run, shown in Settings.
  app.get("/api/health", async () => {
    const bin = ctx.config.graphExecutionBin;
    return { ok: true, engine: { bin, version: engineVersion(bin) } };
  });
  // Unauthenticated (outside /api) for Docker HEALTHCHECK and OpenShift probes. It reveals nothing.
  app.get("/healthz", async () => ({ ok: true }));
}
