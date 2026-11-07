import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { tempRepo } from "./__fixtures__/repo.js";

// Runs the built files; vitest.global-setup.ts builds dist/ before the suite.
// The repo root: npm workspaces link node_modules/graph-execution there, so `graph-execution/api` resolves through `exports`.
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const runModule = (code: string) =>
  execa("node", ["--input-type=module", "-e", code], { cwd: repoRoot, timeout: 5000, reject: false });

describe("graph-execution/api", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("exports the run-reading surface without running the CLI", async () => {
    const res = await runModule(`import * as api from "graph-execution/api"; console.log(JSON.stringify(Object.keys(api).sort()));`);
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.stderr).toBe("");
    expect(res.stdout).not.toMatch(/Usage:/);
    const keys = JSON.parse(res.stdout) as string[];
    expect(keys).toEqual(expect.arrayContaining(["stateSchema", "scan", "lockHolder", "readWebJson", "webJsonPath", "EXIT_ABORT", "CLI_PATH", "suiteStateSchema", "RUNS_DIR"]));
  });

  it("CLI_PATH points at the built cli.js", async () => {
    const res = await runModule(`import { CLI_PATH } from "graph-execution/api"; console.log(CLI_PATH);`);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(path.join(repoRoot, "packages", "graph-execution", "dist", "cli.js"));
  });

  it("scan finds a run written in the state schema", async () => {
    const repo = await tempRepo();
    dirs.push(repo);
    const state = {
      runId: "r1",
      provider: "fake",
      startingCommit: "abc",
      integrationBranch: "graph/r1",
      specPath: "spec.md",
      tasksDir: "tasks",
      hashes: { config: "", tasks: "", spec: "" },
      tasks: {},
      review: { phase: "done", round: 0, validationRounds: 0, reports: {} },
      createdAt: new Date().toISOString(),
      status: "done",
    };
    const code = `
      import { stateSchema, scan } from "graph-execution/api";
      import { mkdirSync, writeFileSync } from "node:fs";
      const repo = ${JSON.stringify(repo)};
      const state = stateSchema.parse(${JSON.stringify(state)});
      mkdirSync(repo + "/.graph-execution/r1", { recursive: true });
      writeFileSync(repo + "/.graph-execution/r1/state.json", JSON.stringify(state));
      const s = await scan(repo);
      console.log(JSON.stringify(s.runs.map((r) => ({ id: r.id, type: r.type, kind: r.kind }))));`;
    const res = await runModule(code);
    expect(res.stderr).toBe("");
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual([{ id: "r1", type: "run", kind: "done" }]);
  });
});
