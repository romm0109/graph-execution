// Project sessions (docs/prd/hosted-sessions.md, "Project sessions"): POST /api/sessions { projectId } clones every
// repository of the project on one branch, writes the project folder and opens one terminal in it.
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startFakeForge, type FakeForge } from "../../../scripts/fake-forge.mjs";
import type { AppContext } from "../app.js";
import type { Config } from "../config.js";
import { appWithLogin } from "../test-helpers.js";
import type { SessionView } from "./sessions.js";

let forge: FakeForge;
let app: FastifyInstance;
let cookie: string;
let config: Config;
let ctx: AppContext;
let cleanup: (() => Promise<void>) | undefined;

beforeAll(async () => {
  forge = await startFakeForge();
  forge.addRepo("octo/web", "github");
  forge.addRepo("octo/third", "github");
});

afterAll(async () => {
  await forge.close();
});

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const HELLO = { forge: "github", owner: "octo", name: "hello" } as const;
const WEB = { forge: "github", owner: "octo", name: "web" } as const;
const THIRD = { forge: "github", owner: "octo", name: "third" } as const;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const req = (method: Method, url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });
const cloneOf = (name: string) => path.join(config.workspacesDir, "github", "octo", name);
const projectDir = () => path.join(config.workspacesDir, ".projects", "billing");
const bare = (fullPath: string) => path.join(forge.dir, `${fullPath}.git`);
const git = async (cwd: string, args: string[]) => (await execa("git", args, { cwd })).stdout.trim();

let branchNo = 0;
const uniqueBranch = (p: string) => `${p}-${Date.now()}-${++branchNo}`;

async function start(overrides: Partial<Config> = {}): Promise<void> {
  const res = await appWithLogin({ githubApiUrl: `${forge.url}/github`, ...overrides }, { sessions: { pollMs: 20, liveRuns: async () => 0 }, onContext: (c) => (ctx = c) });
  ({ app, cookie, config, cleanup } = res);
  expect((await req("PUT", "/api/forges/github", { token: "gh-good" })).statusCode).toBe(200);
  const made = await req("POST", "/api/projects", { name: "billing", repos: [HELLO, WEB] });
  expect(made.statusCode, made.body).toBe(201);
}

async function openProject(branch?: object): Promise<{ sessionId: string; terminalId: string; branch: string }> {
  const res = await req("POST", "/api/sessions", { projectId: "billing", ...(branch ? { branch } : {}) });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

/** Runs `cmd` in the terminal and resolves with its output once `marker` shows. */
function runIn(terminalId: string, cmd: string, marker: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`no ${String(marker)} in: ${out}`)), 10_000);
    const att = ctx.terminals.attach(
      terminalId,
      (d) => {
        out += d;
        if (marker.test(out)) {
          clearTimeout(timer);
          att.detach();
          resolve(out);
        }
      },
      () => undefined,
      () => undefined,
    );
    att.write(`${cmd}\r`);
  });
}

describe.skipIf(process.platform === "win32")("project sessions", () => {
  it("clones every repository on one branch, writes the project folder and opens a terminal in it", async () => {
    await start();
    const branch = uniqueBranch("gm/x");
    const s = await openProject({ new: branch });
    expect(s.branch).toBe(branch);
    for (const name of ["hello", "web"]) expect(await git(cloneOf(name), ["branch", "--show-current"])).toBe(branch);

    const dir = projectDir();
    expect(JSON.parse(readFileSync(path.join(dir, "project.json"), "utf8"))).toEqual({
      name: "billing",
      repos: [
        { name: "hello", path: "repos/hello" },
        { name: "web", path: "repos/web" },
      ],
    });
    expect(lstatSync(path.join(dir, "repos", "web")).isSymbolicLink()).toBe(true);
    expect(realpathSync(path.join(dir, "repos", "web"))).toBe(realpathSync(cloneOf("web")));
    expect(existsSync(path.join(dir, ".git"))).toBe(true);
    expect(await git(dir, ["log", "--format=%s"])).toBe("chore: create project billing");

    const sessions = (await req("GET", "/api/sessions")).json<{ sessions: SessionView[] }>().sessions;
    expect(sessions).toEqual([
      expect.objectContaining({ id: s.sessionId, projectId: "billing", workspaceId: "project~billing", branch, state: "live", repo: HELLO, repos: [HELLO, WEB] }),
    ]);
    const term = ctx.terminals.get(s.terminalId);
    expect(term).toMatchObject({ cwd: dir, projectId: "billing", sessionId: s.sessionId, title: "billing" });
    expect(await runIn(s.terminalId, "echo GMP=$GM_PROJECT_ID:$(pwd -P)", /GMP=billing:\S+/)).toContain(`GMP=billing:${realpathSync(dir)}`);

    // A second POST joins the same session; its branch is ignored.
    const again = await openProject({ new: "ignored" });
    expect(again).toMatchObject({ sessionId: s.sessionId, branch });
    expect(again.terminalId).not.toBe(s.terminalId);
    expect((await req("GET", "/api/sessions")).json<{ sessions: SessionView[] }>().sessions).toHaveLength(1);
  });

  it("answers 404 for an unknown project", async () => {
    await start();
    const res = await req("POST", "/api/sessions", { projectId: "nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "project not found" });
  });

  it("counts as one session toward GM_MAX_SESSIONS", async () => {
    await start({ maxSessions: 1 });
    await openProject();
    const res = await req("POST", "/api/sessions", { repo: THIRD });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "You have 1 open repositories. Close all terminals of one to open another." });
  });

  it("asks with <repo>/<file> paths when the last terminal closes, and push pushes the changed repository", async () => {
    await start();
    const branch = uniqueBranch("gm/push");
    const s = await openProject({ new: branch });
    await writeFile(path.join(cloneOf("hello"), "a.txt"), "a\n");
    const del = await req("DELETE", `/api/terminals/${s.terminalId}`);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ sessionId: s.sessionId, ask: { changes: ["?? hello/a.txt"] } });
    const res = await req("POST", `/api/sessions/${s.sessionId}/close`, { action: "push" });
    expect(res.statusCode, res.body).toBe(200);
    await ctx.sessions.settled();
    expect((await req("GET", "/api/sessions")).json<{ sessions: SessionView[] }>().sessions).toEqual([]);
    expect(await git(forge.dir, ["--git-dir", bare("octo/hello"), "show", `${branch}:a.txt`])).toBe("a");
    expect(await git(forge.dir, ["--git-dir", bare("octo/web"), "branch", "--list", branch])).toContain(branch);
    // The folder stays for the next session; the project's settings are refused while it is open only.
    expect(existsSync(path.join(projectDir(), "project.json"))).toBe(true);
    expect((await req("PATCH", "/api/projects/billing", { repos: [HELLO, WEB, THIRD] })).statusCode).toBe(200);
    // A branch only some repositories have: the error names the repository.
    const missing = await req("POST", "/api/sessions", { projectId: "billing", branch: { existing: branch } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: `octo/third: branch ${branch} not found` });
    await openProject({ new: uniqueBranch("gm/next") });
    expect(JSON.parse(readFileSync(path.join(projectDir(), "project.json"), "utf8")).repos.map((r: { name: string }) => r.name)).toEqual(["hello", "web", "third"]);
  });

  it("refuses to change or delete the project while its session is live", async () => {
    await start();
    await openProject();
    const patch = await req("PATCH", "/api/projects/billing", { repos: [HELLO, THIRD] });
    expect(patch.statusCode).toBe(409);
    expect(patch.json()).toEqual({ error: "project billing has a live session. Close it first." });
    const del = await req("DELETE", "/api/projects/billing");
    expect(del.statusCode).toBe(409);
  });
});
