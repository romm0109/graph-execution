// The shared contract of every WorkspaceHost (not a *.test.ts: host/local.test.ts and the remote agent's tests run it).
// It uses only the public WorkspaceHost API plus the plain files of the bare remote: the clone on disk is found
// through `host.git(id, ["rev-parse", "--show-toplevel"])`, never from the workspaces folder.
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { stateSchema } from "graph-execution/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../test-helpers.js";
import type { HostError, WorkspaceHost } from "./types.js";

export interface HostContractEnv {
  workspacesDir: string;
  loginHome: string;
  graphExecutionBin: string;
}

const SEED = "# api\n\nThe seed README.\n";
const RUN_ID = "gm-20260101-000000-abcd";
const repo = { forge: "github", owner: "acme", name: "api" } as const;
const ID = "github~acme~api";

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const git = async (cwd: string, args: string[]): Promise<string> => String((await execa("git", args, { cwd, env: gitEnv })).stdout);
const b64 = (s: string): string => Buffer.from(s).toString("base64");

async function expectHostError(p: Promise<unknown>, status: number, message?: string): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect((err as HostError).name).toBe("HostError");
  expect((err as HostError).status).toBe(status);
  if (message !== undefined) expect((err as Error).message).toBe(message);
}

export function hostContractSuite(
  name: string,
  makeHost: (env: HostContractEnv) => Promise<{ host: WorkspaceHost; close(): Promise<void> }>,
): void {
  describe(name, () => {
    let cleanup: () => Promise<void>;
    let dir: string;
    let bare: string;
    let cloneUrl: string;
    let host: WorkspaceHost;
    let close: () => Promise<void>;

    beforeEach(async () => {
      const t = await tempDir("gm-host-");
      cleanup = t.cleanup;
      dir = t.dir;
      bare = path.join(dir, "remote", "acme", "api.git");
      await mkdir(path.dirname(bare), { recursive: true });
      await execa("git", ["init", "--bare", "-q", "-b", "main", bare]);
      const seed = path.join(dir, "seed");
      await execa("git", ["clone", "-q", bare, seed], { env: gitEnv });
      await git(seed, ["checkout", "-q", "-b", "main"]);
      await writeFile(path.join(seed, "README.md"), SEED);
      await writeFile(path.join(seed, ".gitignore"), "ignored.txt\n");
      await git(seed, ["add", "-A"]);
      await git(seed, ["commit", "-q", "-m", "seed"]);
      await git(seed, ["push", "-q", "origin", "main"]);
      await git(seed, ["checkout", "-q", "-b", "feature"]);
      await writeFile(path.join(seed, "feature.txt"), "feature\n");
      await git(seed, ["add", "-A"]);
      await git(seed, ["commit", "-q", "-m", "feature"]);
      await git(seed, ["push", "-q", "origin", "feature"]);
      cloneUrl = pathToFileURL(bare).href;

      const engine = path.join(dir, "fake-engine.js");
      await writeFile(
        engine,
        `if (process.argv.includes("--fail")) { console.error("boom"); process.exit(2); }\nconsole.log("Run ${RUN_ID} started: http://x");\n`,
      );
      const workspacesDir = path.join(dir, "ws");
      const loginHome = path.join(dir, "home");
      await mkdir(workspacesDir, { recursive: true });
      await mkdir(loginHome, { recursive: true });
      ({ host, close } = await makeHost({ workspacesDir, loginHome, graphExecutionBin: engine }));
    });

    afterEach(async () => {
      await close();
      await cleanup();
    });

    /** Clones on `gm/t-1` and returns the clone's folder (as the host reports it). */
    async function prepared(): Promise<string> {
      await host.prepare({ repo, branch: { new: "gm/t-1" }, cloneUrl });
      return (await host.git(ID, ["rev-parse", "--show-toplevel"])).stdout.trim();
    }

    it("prepare clones the repo on a new branch", async () => {
      expect(await host.prepare({ repo, branch: { new: "gm/t-1" }, cloneUrl })).toEqual({ workspaceId: ID, branch: "gm/t-1" });
      expect((await host.git(ID, ["branch", "--show-current"])).stdout.trim()).toBe("gm/t-1");
      expect(await host.readFile(ID, "README.md")).toBe(SEED);
      await expectHostError(host.prepare({ repo, branch: { new: "gm/t-1" }, cloneUrl }), 409, "branch gm/t-1 already exists");
      await expectHostError(host.prepare({ repo, branch: { new: "bad..name" }, cloneUrl }), 400, "invalid branch name: bad..name");
      await expectHostError(host.prepare({ repo, branch: { existing: "nope" }, cloneUrl }), 404, "branch nope not found");
    });

    it("prepare switches to an existing branch, and refuses to leave uncommitted changes", async () => {
      await host.prepare({ repo, branch: { new: "gm/t-1" }, cloneUrl });
      expect(await host.prepare({ repo, branch: { existing: "feature" }, cloneUrl })).toEqual({ workspaceId: ID, branch: "feature" });
      expect(await host.readFile(ID, "feature.txt")).toBe("feature\n");
      const top = (await host.git(ID, ["rev-parse", "--show-toplevel"])).stdout.trim();
      await writeFile(path.join(top, "dirty.txt"), "x");
      await expectHostError(
        host.prepare({ repo, branch: { existing: "main" }, cloneUrl }),
        409,
        "acme/api has uncommitted changes. Close its session with Push or Discard first.",
      );
      expect(await host.prepare({ repo, branch: { existing: "feature" }, cloneUrl })).toEqual({ workspaceId: ID, branch: "feature" });
    });

    it("reads, stats and lists files only inside the workspace", async () => {
      const top = await prepared();
      expect(await host.readFile(ID, "missing.md")).toBeUndefined();
      expect(await host.readFile(ID, "../outside")).toBeUndefined();
      expect(await host.readFile(ID, path.join(top, "README.md"))).toBeUndefined();
      await mkdir(path.join(top, "docs"), { recursive: true });
      expect(await host.stat(ID, "docs")).toMatchObject({ kind: "dir", symlink: false });
      expect(await host.stat(ID, "README.md")).toMatchObject({ kind: "file", size: SEED.length, symlink: false });
      expect(await host.stat(ID, "missing.md")).toBeUndefined();
      expect(await host.stat(ID, "../outside")).toBeUndefined();
      expect(await host.listFiles(ID, ".", { glob: "*.md" })).toEqual(["README.md"]);
      expect(await host.readFile("github~nobody~here", "README.md")).toBeUndefined();
    });

    it("save commits and pushes every change git does not ignore", async () => {
      const top = await prepared();
      for (const f of ["a.txt", ".env", "x.pem", "ignored.txt"]) await writeFile(path.join(top, f), `${f}\n`);
      const changes = await host.changes(ID);
      expect(changes.some((l) => l.endsWith("a.txt"))).toBe(true);
      expect(changes.some((l) => l.endsWith("ignored.txt"))).toBe(false);
      const res = await host.save({ workspaceId: ID, branch: "gm/t-1", message: "graph-manager: save session s1" });
      expect(res.pushed).toBe(true);
      expect(res.error).toBeUndefined();
      expect(res.skipped).toEqual([]);
      expect(await git(dir, ["--git-dir", bare, "show", "gm/t-1:a.txt"])).toBe("a.txt");
      expect(await git(dir, ["--git-dir", bare, "log", "-1", "--format=%s", "gm/t-1"])).toBe("graph-manager: save session s1");
      const files = await git(dir, ["--git-dir", bare, "ls-tree", "-r", "--name-only", "gm/t-1"]);
      expect(files.split("\n")).toEqual(expect.arrayContaining([".env", "a.txt", "x.pem"]));
      expect(files.split("\n")).not.toContain("ignored.txt");
    });

    it("save reports a push that fails", async () => {
      const top = await prepared();
      await writeFile(path.join(top, "a.txt"), "a\n");
      await rename(bare, `${bare}.gone`);
      const res = await host.save({ workspaceId: ID, branch: "gm/t-1", message: "save" });
      expect(res.pushed).toBe(false);
      expect(res.error).toEqual(expect.any(String));
    });

    it("discard drops changes and new files but keeps ignored ones", async () => {
      const top = await prepared();
      await writeFile(path.join(top, "new.txt"), "new\n");
      await writeFile(path.join(top, "README.md"), "changed\n");
      await writeFile(path.join(top, "ignored.txt"), "keep\n");
      await host.discard(ID);
      expect(await host.changes(ID)).toEqual([]);
      expect(await host.readFile(ID, "new.txt")).toBeUndefined();
      expect(await host.readFile(ID, "README.md")).toBe(SEED);
      expect(await host.readFile(ID, "ignored.txt")).toBe("keep\n");
    });

    it("pushBranch pushes the current branch", async () => {
      await prepared();
      expect(await host.pushBranch(ID)).toEqual({ ok: true });
      expect(await git(dir, ["--git-dir", bare, "branch", "--list", "gm/t-1"])).toContain("gm/t-1");
    });

    it("startEngine reports the engine's start and its failure", async () => {
      await prepared();
      const ok = await host.startEngine({ workspaceId: ID, args: [], env: {}, timeoutMs: 30_000 });
      expect(ok.ok).toBe(true);
      expect(ok.ok && ok.stdout).toContain("started");
      const bad = await host.startEngine({ workspaceId: ID, args: ["--fail"], env: {}, timeoutMs: 30_000 });
      expect(bad).toMatchObject({ ok: false, exitCode: 2 });
      expect(!bad.ok && bad.output).toContain("boom");
    });

    it("lists the runs of the workspace and their detail", async () => {
      const top = await prepared();
      const runDir = path.join(top, ".graph-execution", RUN_ID);
      const tasksDir = path.join(runDir, "tasks");
      await mkdir(tasksDir, { recursive: true });
      await writeFile(path.join(tasksDir, "1.json"), JSON.stringify({ id: "1", content: "# Say hello\n\nWrite hello.txt.", dependencies: [] }));
      const specPath = path.join(runDir, "spec.md");
      await writeFile(specPath, "# Hello feature\n");
      const state = stateSchema.parse({
        runId: RUN_ID,
        provider: "fake",
        startingCommit: "0".repeat(40),
        integrationBranch: `graph/${RUN_ID}`,
        specPath,
        tasksDir,
        hashes: { config: "", tasks: "", spec: "" },
        tasks: { "1": { status: "merged", attempts: 1 } },
        review: { phase: "validate", round: 0, validationRounds: 0, reports: {} },
        createdAt: "2026-11-06T10:00:00.000Z",
        status: "failed",
      });
      await writeFile(path.join(runDir, "state.json"), JSON.stringify(state));
      const runs = await host.listRuns(ID);
      expect(runs.map((r) => [r.workspaceId, r.id])).toEqual([[ID, RUN_ID]]);
      expect((await host.runDetail(ID, RUN_ID))?.summary.id).toBe(RUN_ID);
      expect(await host.runDetail(ID, "gm-20260101-000000-ffff")).toBeUndefined();
    });

    it("puts and gets agent login files", async () => {
      const files = { ".claude/.credentials.json": b64("x") };
      expect(await host.loginFiles("put", ["claude"], files)).toEqual({});
      expect(await host.loginFiles("get", ["claude"])).toEqual(files);
      await expectHostError(host.loginFiles("put", ["claude"], { "notes.txt": b64("y") }), 400, "not a login file: notes.txt");
    });

    describe("a project", () => {
      const api = { forge: "github", owner: "octo", name: "api" } as const;
      const web = { forge: "github", owner: "octo", name: "web" } as const;
      const PID = "project~billing";
      let bares: Record<string, string>;
      let urls: string[];

      beforeEach(async () => {
        bares = {};
        for (const name of ["api", "web"]) {
          const b = path.join(dir, "remote", "octo", `${name}.git`);
          await mkdir(path.dirname(b), { recursive: true });
          await execa("git", ["init", "--bare", "-q", "-b", "main", b]);
          const seed = path.join(dir, `seed-${name}`);
          await execa("git", ["clone", "-q", b, seed], { env: gitEnv });
          await git(seed, ["checkout", "-q", "-b", "main"]);
          await writeFile(path.join(seed, "README.md"), `# ${name}\n`);
          await git(seed, ["add", "-A"]);
          await git(seed, ["commit", "-q", "-m", "seed"]);
          await git(seed, ["push", "-q", "origin", "main"]);
          bares[name] = b;
        }
        urls = [pathToFileURL(bares.api!).href, pathToFileURL(bares.web!).href];
      });

      const prepareProject = () =>
        host.prepare({ project: { id: "billing", name: "billing", repos: [api, web], cloneUrls: urls }, branch: { new: "gm/test-1" } });

      it("prepare clones every repository on the branch and writes the project folder", async () => {
        expect(await prepareProject()).toEqual({ workspaceId: PID, branch: "gm/test-1" });
        for (const id of ["github~octo~api", "github~octo~web"]) expect((await host.git(id, ["branch", "--show-current"])).stdout.trim()).toBe("gm/test-1");
        expect(JSON.parse((await host.readFile(PID, "project.json")) ?? "null")).toEqual({
          name: "billing",
          repos: [
            { name: "api", path: "repos/api" },
            { name: "web", path: "repos/web" },
          ],
        });
        // The links point out of the folder: reads through them are refused like any path outside it.
        expect(await host.readFile(PID, "repos/web/README.md")).toBeUndefined();
        expect((await host.git(PID, ["log", "--format=%s"])).stdout.trim()).toBe("chore: create project billing");
        expect(await host.changes(PID)).toEqual([]);
      });

      it("changes, save and discard act on every repository", async () => {
        await prepareProject();
        const apiTop = (await host.git("github~octo~api", ["rev-parse", "--show-toplevel"])).stdout.trim();
        const webTop = (await host.git("github~octo~web", ["rev-parse", "--show-toplevel"])).stdout.trim();
        await writeFile(path.join(apiTop, "a.txt"), "a\n");
        expect(await host.changes(PID)).toEqual(["?? api/a.txt"]);
        await writeFile(path.join(webTop, "w.txt"), "w\n");
        await writeFile(path.join(webTop, ".env"), "SECRET=1\n");
        const res = await host.save({ workspaceId: PID, branch: "gm/test-1", message: "graph-manager: save session s1" });
        expect(res).toEqual({ pushed: true, skipped: [] });
        expect(await git(dir, ["--git-dir", bares.api!, "show", "gm/test-1:a.txt"])).toBe("a");
        expect(await git(dir, ["--git-dir", bares.web!, "show", "gm/test-1:w.txt"])).toBe("w");
        // Not git-ignored in this repository, so it is committed like any other file.
        expect(await git(dir, ["--git-dir", bares.web!, "show", "gm/test-1:.env"])).toBe("SECRET=1");

        await writeFile(path.join(apiTop, "b.txt"), "b\n");
        await writeFile(path.join(webTop, "README.md"), "changed\n");
        await host.discard(PID);
        expect(await host.changes(PID)).toEqual([]);
        expect(await host.readFile("github~octo~web", "README.md")).toBe("# web\n");
      });

      it("save names the repository whose push failed", async () => {
        await prepareProject();
        const webTop = (await host.git("github~octo~web", ["rev-parse", "--show-toplevel"])).stdout.trim();
        await writeFile(path.join(webTop, "w.txt"), "w\n");
        await rename(bares.web!, `${bares.web!}.gone`);
        const res = await host.save({ workspaceId: PID, branch: "gm/test-1", message: "save" });
        expect(res.pushed).toBe(false);
        expect(res.error).toMatch(/^web: /);
        expect(await git(dir, ["--git-dir", bares.api!, "branch", "--list", "gm/test-1"])).toContain("gm/test-1");
      });
    });

    it.skipIf(process.platform === "win32")("spawns a PTY in the workspace and counts it in activity()", async () => {
      await prepared();
      const proc = await host.spawnPty({ workspaceId: ID, argv: ["/bin/sh", "-c", "printf hi; sleep 1; exit 3"], env: {}, cols: 80, rows: 24 });
      let out = "";
      let sawOutput!: () => void;
      const output = new Promise<void>((r) => (sawOutput = r));
      const exited = new Promise<number>((r) => proc.onExit((e) => r(e.exitCode)));
      const before = Date.now();
      proc.onData((d) => {
        out += d;
        if (out.includes("hi")) sawOutput();
      });
      await output;
      const act = await host.activity();
      expect(act.terminals).toBeGreaterThanOrEqual(1);
      expect(act.lastOutputAt).not.toBeNull();
      expect(Date.parse(act.lastOutputAt!)).toBeGreaterThanOrEqual(before - 1000);
      expect(await exited).toBe(3);
      expect(out).toContain("hi");
    });
  });
}
