// The built shim (dist/server/shim.js), skipped until `npm run build -w graph-manager` made it.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const SHIM = fileURLToPath(new URL("../../dist/server/shim.js", import.meta.url));
const ENGINE = fileURLToPath(new URL("../../../../packages/graph-execution/dist/cli.js", import.meta.url));
const ENGINE_PKG = fileURLToPath(new URL("../../../../packages/graph-execution/package.json", import.meta.url));

describe.skipIf(!existsSync(SHIM) || !existsSync(ENGINE))("dist/server/shim.js", () => {
  it("runs the engine", async () => {
    const { version } = (await import(ENGINE_PKG, { with: { type: "json" } })).default as { version: string };
    const res = await execa("node", [SHIM, "--version"], { env: { GM_ENGINE_BIN: ENGINE }, reject: false });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(version);
  });

  it("exits 2 with --sandbox outside a graph-manager terminal", async () => {
    const env = { ...process.env, GM_ENGINE_BIN: ENGINE };
    delete env.GM_INTERNAL_TOKEN;
    delete env.GM_INTERNAL_URL;
    const res = await execa("node", [SHIM, "x", "--sandbox"], { env, extendEnv: false, reject: false });
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("works only in a graph-manager terminal");
  });
});
