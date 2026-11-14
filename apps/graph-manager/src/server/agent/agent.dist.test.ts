// The built `graph-manager agent` (dist/server/cli.js); skipped until `npm run build -w graph-manager` made it.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../test-helpers.js";

const CLI = fileURLToPath(new URL("../../../dist/server/cli.js", import.meta.url));

function agentEnv(token: string | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GM_AGENT_TOKEN;
  if (token !== undefined) env.GM_AGENT_TOKEN = token;
  return env;
}

describe.skipIf(!existsSync(CLI))("graph-manager agent (dist)", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let child: ChildProcess | undefined;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir("gm-agent-dist-"));
  });

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const done = new Promise((r) => child!.once("exit", r));
      child.kill("SIGTERM");
      await done;
    }
    child = undefined;
    await cleanup();
  });

  it("serves healthz and checks the token", async () => {
    const token = randomBytes(32).toString("hex");
    child = spawn(process.execPath, [CLI, "agent", "--port", "0", "--workspaces", dir, "--host", "127.0.0.1"], {
      env: agentEnv(token),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => (stderr += String(c)));
    const url = await new Promise<string>((resolve, reject) => {
      const rl = createInterface({ input: child!.stdout! });
      rl.on("line", (line) => {
        const m = /listening on (http:\/\/\S+)/.exec(line);
        if (m) resolve(m[1]!);
      });
      child!.once("exit", (code) => reject(new Error(`exited ${String(code)}: ${stderr}`)));
    });
    const health = await fetch(`${url}/agent/v1/healthz`);
    expect(await health.json()).toEqual({ ok: true });
    expect((await fetch(`${url}/agent/v1/activity`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await fetch(`${url}/agent/v1/activity`)).status).toBe(401);
  });

  it.each([undefined, "0123456789"])("refuses to start with GM_AGENT_TOKEN=%s", async (token) => {
    child = spawn(process.execPath, [CLI, "agent", "--port", "0", "--workspaces", dir, "--host", "127.0.0.1"], {
      env: agentEnv(token),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => (stderr += String(c)));
    const code = await new Promise<number | null>((r) => child!.once("exit", r));
    expect(code).not.toBe(0);
    expect(stderr).toContain("GM_AGENT_TOKEN is required (at least 32 characters)");
  });
});
