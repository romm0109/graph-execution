// Test-only: an app with a workspace terminal and a root terminal, for the tools' tests.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { stateSchema } from "graph-execution/api";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import { cookieOf, tempDir, testConfig } from "../test-helpers.js";

export const TOKEN = "t0ken";

export interface ToolApp {
  app: FastifyInstance;
  config: Config;
  cookie: string;
  /** `<workspacesDir>/github/octo/hello`, a git repo with one empty commit. */
  wsDir: string;
  /** "github~octo~hello" */
  wsId: string;
  /** A terminal of the workspace. */
  terminalId: string;
  /** A terminal outside every workspace (cwd = workspacesDir). */
  rootTerminalId: string;
  call(name: string, input: unknown, opts?: { cwd?: string; terminalId?: string }): Promise<{ text: string; isError?: boolean }>;
  /** app.close(), then removes the temp dir. */
  cleanup(): Promise<void>;
}

export async function toolApp(overrides: Partial<Config> = {}): Promise<ToolApp> {
  const t = await tempDir();
  const config = testConfig(t.dir, overrides);
  const wsDir = path.join(config.workspacesDir, "github", "octo", "hello");
  const wsId = "github~octo~hello";
  await mkdir(wsDir, { recursive: true });
  await execa("git", ["init", "-q", "-b", "main"], { cwd: wsDir });
  await execa("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: wsDir });
  const app = await buildApp(config, { webDir: path.join(t.dir, "no-web"), viewCache: false, internalToken: TOKEN });
  try {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: config.password } });
    if (login.statusCode !== 204) throw new Error(`login failed: ${login.statusCode}`);
    const cookie = cookieOf(login);
    const terminal = async (payload: Record<string, unknown>): Promise<string> => {
      const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload });
      if (res.statusCode !== 201) throw new Error(`terminal: ${res.statusCode} ${res.body}`);
      return (res.json() as { id: string }).id;
    };
    const terminalId = await terminal({ workspaceId: wsId });
    const rootTerminalId = await terminal({});
    return {
      app,
      config,
      cookie,
      wsDir,
      wsId,
      terminalId,
      rootTerminalId,
      async call(name, input, opts = {}) {
        const res = await app.inject({
          method: "POST",
          url: `/api/internal/tools/${name}`,
          headers: { authorization: `Bearer ${TOKEN}` },
          payload: { terminalId: opts.terminalId ?? terminalId, cwd: opts.cwd ?? wsDir, input },
        });
        if (res.statusCode !== 200) throw new Error(`tool ${name}: ${res.statusCode} ${res.body}`);
        return res.json() as { text: string; isError?: boolean };
      },
      async cleanup() {
        await app.close();
        await t.cleanup();
      },
    };
  } catch (err) {
    await app.close();
    await t.cleanup();
    throw err;
  }
}

/** Writes `<wsDir>/.graph-execution/<runId>/state.json` from a valid base state merged with `overrides`; returns the run folder. */
export async function writeRun(wsDir: string, runId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const state = stateSchema.parse({
    runId,
    provider: "fake",
    startingCommit: "0".repeat(40),
    integrationBranch: `graph/${runId}`,
    specPath: path.join(wsDir, "spec.md"),
    tasksDir: path.join(wsDir, ".agents/tasks/demo"),
    hashes: { config: "", tasks: "", spec: "" },
    tasks: { "1": { status: "merged", attempts: 1 }, "2": { status: "failed", attempts: 2 } },
    review: { phase: "validate", round: 0, validationRounds: 0, reports: {} },
    createdAt: "2026-11-06T10:00:00.000Z",
    status: "failed",
    ...overrides,
  });
  const runDir = path.join(wsDir, ".graph-execution", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "state.json"), JSON.stringify(state));
  return runDir;
}
