import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../test-helpers.js";
import { hostContractSuite } from "./contract.js";
import { LocalWorkspaceHost } from "./local.js";
import { HostError } from "./types.js";

hostContractSuite("LocalWorkspaceHost", async (env) => ({
  host: new LocalWorkspaceHost({ workspacesDir: env.workspacesDir, graphExecutionBin: env.graphExecutionBin, loginHome: env.loginHome }),
  close: async () => {},
}));

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const repo = { forge: "github", owner: "acme", name: "api" } as const;
const ID = "github~acme~api";

describe("LocalWorkspaceHost", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let host: LocalWorkspaceHost;
  let bare: string;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir("gm-local-host-"));
    bare = path.join(dir, "api.git");
    await execa("git", ["init", "--bare", "-q", "-b", "main", bare]);
    const seed = path.join(dir, "seed");
    await execa("git", ["clone", "-q", bare, seed], { env: gitEnv });
    await execa("git", ["checkout", "-q", "-b", "main"], { cwd: seed, env: gitEnv });
    await writeFile(path.join(seed, "README.md"), "seed\n");
    await execa("git", ["add", "-A"], { cwd: seed, env: gitEnv });
    await execa("git", ["commit", "-q", "-m", "seed"], { cwd: seed, env: gitEnv });
    await execa("git", ["push", "-q", "origin", "main"], { cwd: seed, env: gitEnv });
    await mkdir(path.join(dir, "ws"));
    host = new LocalWorkspaceHost({ workspacesDir: path.join(dir, "ws"), graphExecutionBin: "graph-execution" });
  });

  afterEach(async () => {
    await cleanup();
  });

  it("loginFiles is a no-op without a loginHome", async () => {
    expect(await host.loginFiles("get", ["claude"])).toEqual({});
    expect(await host.loginFiles("put", ["claude"], { "notes.txt": "eA==" })).toEqual({});
  });

  it("save honours the filter", async () => {
    await host.prepare({ repo, branch: { new: "gm/t-1" }, cloneUrl: pathToFileURL(bare).href });
    const top = (await host.git(ID, ["rev-parse", "--show-toplevel"])).stdout.trim();
    await writeFile(path.join(top, "a.txt"), "a\n");
    await writeFile(path.join(top, "b.txt"), "b\n");
    const res = await host.save({ workspaceId: ID, branch: "gm/t-1", message: "save", filter: (p) => p !== "a.txt" });
    expect(res).toEqual({ pushed: true, skipped: ["a.txt"] });
    const files = (await execa("git", ["--git-dir", bare, "ls-tree", "-r", "--name-only", "gm/t-1"])).stdout.split("\n");
    expect(files).toContain("b.txt");
    expect(files).not.toContain("a.txt");
  });

  it("refuses a project with an unsafe id or no repositories", async () => {
    for (const project of [{ id: "../x", repos: [repo] }, { id: "p", repos: [] }]) {
      const err = await host.prepare({ project, branch: { new: "x" } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HostError);
      expect((err as HostError).status).toBe(400);
    }
  });

  it("refuses operations on an unknown workspace with 404", async () => {
    const err = await host.git("github~nobody~here", ["status"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostError);
    expect((err as HostError).status).toBe(404);
    expect(await host.listRuns("github~nobody~here")).toEqual([]);
    expect(await host.runDetail("github~nobody~here", "gm-20260101-000000-abcd")).toBeUndefined();
  });

  it("never writes the forge token to .git/config", async () => {
    // A file:// remote ignores the header; the clone must still work and leave no trace of the token.
    await host.prepare({ repo, branch: { new: "gm/t-1" }, cloneUrl: pathToFileURL(bare).href, auth: { forge: "github", token: "s3cret-token" } });
    const top = (await host.git(ID, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const config = (await execa("git", ["config", "--list", "--local"], { cwd: top })).stdout;
    expect(config).not.toContain("extraheader");
    expect(config).not.toContain("s3cret-token");
  });
});
