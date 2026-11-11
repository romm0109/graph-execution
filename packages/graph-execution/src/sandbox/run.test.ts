import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerCalls, readFakeDockerState, writeFakeDocker } from "../__fixtures__/fake-docker.js";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { UsageError } from "../launch/preflight.js";
import type { Exec } from "./docker.js";
import { containerArgs, loginFiles, SANDBOX_FILE, sandboxEnv, sandboxLiveness, startSandboxedRun } from "./run.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const cli = path.join(root, "dist", "cli.js");
const fixture = (name: string): string => path.join(root, "src", "__fixtures__", name);

describe("containerArgs", () => {
  it("drops --sandbox, --web and the --sandbox-* flags with their values, and keeps the rest", () => {
    expect(
      containerArgs([
        "tasks",
        "--spec",
        "s.md",
        "--sandbox",
        "--web",
        "--sandbox-line",
        "RUN echo hi",
        "--sandbox-base=node:22",
        "--no-sandbox-config-lines",
        "--sandbox-cpus",
        "4",
        "--review-provider",
        "codex",
        "--model",
        "--web",
        "--provider",
        "fake",
      ]),
    ).toEqual(["tasks", "--spec", "s.md", "--review-provider", "codex", "--model", "--web", "--provider", "fake"]);
  });
});

describe("sandboxEnv", () => {
  it("passes login keys, identity and public GRAPH_EXECUTION_* vars; never GM_ or internal ones", () => {
    const env = sandboxEnv(
      {
        ANTHROPIC_API_KEY: "k",
        GM_PASSWORD: "secret",
        HOME: "/home/me",
        PATH: "/usr/bin",
        GRAPH_EXECUTION_CLAUDE_ARGS: "--x",
        GRAPH_EXECUTION_HANDOFF: "detached",
        GRAPH_EXECUTION_RUNS_ROOT: "/r",
        GRAPH_EXECUTION_DELEGATE_X: "1",
        GRAPH_EXECUTION_WEB_HOST: "1.2.3.4",
        MY_VAR: "v",
        GIT_AUTHOR_NAME: "Env Name",
      },
      {
        runId: "r1",
        runDir: "/repo/.graph-execution/r1",
        image: "img",
        hostPort: 4321,
        token: "tok",
        names: ["MY_VAR"],
        gitIdentity: { GIT_AUTHOR_NAME: "Git Name", GIT_AUTHOR_EMAIL: "a@b" },
        imagePath: "/img/bin",
        takeLockFrom: "sbx-1234abcd",
      },
    );
    expect(env).toEqual(
      expect.arrayContaining([
        "ANTHROPIC_API_KEY=k",
        "GRAPH_EXECUTION_CLAUDE_ARGS=--x",
        "MY_VAR=v",
        "GIT_AUTHOR_NAME=Env Name",
        "GIT_AUTHOR_EMAIL=a@b",
        "GRAPH_EXECUTION_SANDBOX=1",
        "GRAPH_EXECUTION_SANDBOX_IMAGE=img",
        "GRAPH_EXECUTION_RUN_ID=r1",
        "GRAPH_EXECUTION_WEB_HOST=0.0.0.0",
        "GRAPH_EXECUTION_WEB_PORT=7600",
        "GRAPH_EXECUTION_WEB_PUBLIC_PORT=4321",
        "GRAPH_EXECUTION_WEB_TOKEN=tok",
        "GRAPH_EXECUTION_READY_FILE=/repo/.graph-execution/r1/.ready.json",
        "HOME=/home/sandbox",
        "PATH=/img/bin",
        "GRAPH_EXECUTION_TAKE_LOCK_FROM=sbx-1234abcd",
      ]),
    );
    expect(env.some((e) => e.startsWith("GM_"))).toBe(false);
    for (const k of ["GRAPH_EXECUTION_HANDOFF", "GRAPH_EXECUTION_RUNS_ROOT", "GRAPH_EXECUTION_DELEGATE_X"]) {
      expect(env.some((e) => e.startsWith(`${k}=`))).toBe(false);
    }
    expect(env.filter((e) => e.startsWith("HOME=") || e.startsWith("PATH="))).toEqual(["HOME=/home/sandbox", "PATH=/img/bin"]);
  });
});

describe("loginFiles", () => {
  it("lists the login files and folders, and refuses a provider with no login", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ge-login-home-"));
    try {
      await mkdir(path.join(home, ".claude"), { recursive: true });
      await writeFile(path.join(home, ".claude", ".credentials.json"), "{}");
      await mkdir(path.join(home, ".config", "opencode", "sub"), { recursive: true });
      await writeFile(path.join(home, ".config", "opencode", "sub", "a.json"), "{}");
      const files = await loginFiles(["claude", "opencode", "fake"], home, {});
      expect(files.map((f) => f.rel)).toEqual([".claude/.credentials.json", ".config/opencode/sub/a.json"]);
      await expect(loginFiles(["codex"], home, {})).rejects.toThrow("no codex login to copy into the sandbox: log in once, or set OPENAI_API_KEY");
      expect(await loginFiles(["codex"], home, { OPENAI_API_KEY: "k" })).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("sandboxLiveness", () => {
  const execFor = (result: { exitCode: number; stdout?: string; stderr?: string }): Exec => async () => ({ stdout: "", stderr: "", ...result });
  it("reads the container's state: running, exited, missing, and unknown when docker cannot tell", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ge-liveness-"));
    try {
      expect(await sandboxLiveness(dir, { exec: execFor({ exitCode: 0 }) })).toBeUndefined();
      await writeFile(
        path.join(dir, SANDBOX_FILE),
        JSON.stringify({ container: "ge-sbx-r", image: "i", hostname: "sbx-1", url: "http://127.0.0.1:1/", token: "t", host: "h" }),
      );
      const running = await sandboxLiveness(dir, { exec: execFor({ exitCode: 0, stdout: '{"Status":"running","Running":true}' }) });
      expect(running).toMatchObject({ state: "running", live: true });
      const exited = await sandboxLiveness(dir, { exec: execFor({ exitCode: 0, stdout: '{"Status":"exited","Running":false}' }) });
      expect(exited).toMatchObject({ state: "exited", live: false });
      const missing = await sandboxLiveness(dir, { exec: execFor({ exitCode: 1, stderr: "Error: No such container: ge-sbx-r" }) });
      expect(missing).toMatchObject({ state: "missing", live: false });
      const unknown = await sandboxLiveness(dir, { exec: execFor({ exitCode: 1, stderr: "Cannot connect to the Docker daemon" }) });
      expect(unknown).toMatchObject({ state: "unknown", live: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("startSandboxedRun refusals", () => {
  const base = { args: [], cwd: tmpdir(), flags: {}, preflight: { cwd: tmpdir() } };
  it("refuses Windows", async () => {
    await expect(startSandboxedRun({ ...base, platform: "win32", env: {} })).rejects.toThrow(
      new UsageError("the sandbox needs Linux or macOS; on Windows use WSL"),
    );
  });
  it("refuses inside a sandbox", async () => {
    await expect(startSandboxedRun({ ...base, platform: "linux", env: { GRAPH_EXECUTION_SANDBOX: "1" } })).rejects.toThrow("already running in a sandbox");
  });
  it("refuses the image flags with --resume", async () => {
    await expect(
      startSandboxedRun({ ...base, platform: "linux", env: {}, flags: { sandbox: true, sandboxBase: "x" }, preflight: { cwd: tmpdir(), resume: true } }),
    ).rejects.toThrow("--sandbox-base cannot be used with --resume");
  });
  it("refuses when docker reaches no daemon", async () => {
    const exec: Exec = async () => ({ exitCode: 1, stdout: "", stderr: "Cannot connect" });
    await expect(startSandboxedRun({ ...base, platform: "linux", env: {} }, { exec })).rejects.toThrow("--sandbox needs Docker");
  });
});

/** The CLI with the fake docker first on the PATH. */
describe.skipIf(process.platform === "win32")("graph-execution --sandbox with a fake docker", () => {
  let bin: string;
  let cache: string;
  beforeAll(async () => {
    bin = await mkdtemp(path.join(tmpdir(), "ge-fake-docker-"));
    cache = await mkdtemp(path.join(tmpdir(), "ge-sbx-cache-"));
    await writeFakeDocker(bin);
  });
  afterAll(async () => {
    await rm(bin, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  interface World {
    repo: string;
    work: string;
    log: string;
    state: string;
    home: string;
    env: Record<string, string | undefined>;
  }

  async function withWorld(fn: (w: World) => Promise<void>): Promise<void> {
    const repo = await tempRepo();
    const work = await mkdtemp(path.join(tmpdir(), "ge-sbx-work-"));
    const home = path.join(work, "home");
    await mkdir(home);
    const w: World = {
      repo,
      work,
      log: path.join(work, "docker.jsonl"),
      state: path.join(work, "docker.json"),
      home,
      env: {
        PATH: [bin, process.env.PATH ?? ""].join(path.delimiter),
        FAKE_DOCKER_LOG: path.join(work, "docker.jsonl"),
        FAKE_DOCKER_STATE: path.join(work, "docker.json"),
        GRAPH_EXECUTION_CACHE_DIR: cache,
        SSH_CONNECTION: "1",
        HOME: home,
        GM_PASSWORD: "secret",
        ANTHROPIC_API_KEY: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
      },
    };
    try {
      await fn(w);
    } finally {
      // Stop what exec mode started, by its process group.
      for (const c of Object.values((await readFakeDockerState(w.state)).containers)) {
        if (c.pid) {
          try {
            process.kill(-c.pid, "SIGKILL");
          } catch {
            // Gone.
          }
        }
      }
      await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }

  const runCli = (w: World, args: string[], env: Record<string, string | undefined> = {}) =>
    execa("node", [cli, ...args], { cwd: w.repo, env: { ...w.env, ...env }, reject: false });

  /** The `-e` values of a `create` call. */
  const envOf = (argv: string[]): string[] => argv.flatMap((a, i) => (argv[i - 1] === "-e" ? [a] : []));

  /** Copies the diamond tasks and the spec into the repo (the sandbox mounts only the repo) and commits them. */
  async function addTasks(repo: string): Promise<{ tasks: string; spec: string }> {
    await cp(fixture("diamond"), path.join(repo, "tasks"), { recursive: true });
    await cp(fixture("spec.md"), path.join(repo, "spec.md"));
    await gitOut(repo, ["add", "-A"]);
    await gitOut(repo, ["commit", "-q", "-m", "tasks"]);
    return { tasks: "tasks", spec: "spec.md" };
  }

  /** Waits for the fake's `start`, then writes the ready file the container would write. */
  async function answerReady(w: World): Promise<string> {
    for (let i = 0; i < 300; i++) {
      const calls = await dockerCalls(w.log);
      const create = calls.find((c) => c.argv[0] === "create");
      if (create && calls.some((c) => c.argv[0] === "start")) {
        const ready = envOf(create.argv).find((e) => e.startsWith("GRAPH_EXECUTION_READY_FILE="))!.slice("GRAPH_EXECUTION_READY_FILE=".length);
        await writeFile(ready, JSON.stringify({ url: "http://0.0.0.0:7600/", runId: "x", pid: 1 }));
        return ready;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("no docker start");
  }

  it("refuses --sandbox when GRAPH_EXECUTION_SANDBOX=1", () =>
    withWorld(async (w) => {
      const { tasks, spec } = await addTasks(w.repo);
      const res = await runCli(w, [tasks, "--spec", spec, "--provider", "fake", "--sandbox"], { GRAPH_EXECUTION_SANDBOX: "1" });
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("already running in a sandbox");
    }));

  it("refuses a ready-made image with Dockerfile lines", () =>
    withWorld(async (w) => {
      const { tasks, spec } = await addTasks(w.repo);
      const res = await runCli(w, [tasks, "--spec", spec, "--provider", "fake", "--sandbox", "--sandbox-image", "my/img", "--sandbox-line", "x"]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("--sandbox-image is a ready-made image");
      expect((await dockerCalls(w.log)).some((c) => c.argv[0] === "create")).toBe(false);
    }));

  it("refuses an image that lacks a provider's CLI", () =>
    withWorld(async (w) => {
      const { tasks, spec } = await addTasks(w.repo);
      const res = await runCli(w, [tasks, "--spec", spec, "--provider", "codex", "--sandbox", "--sandbox-image", "my/img"], {
        OPENAI_API_KEY: "k",
        FAKE_DOCKER_IMAGES: "my/img",
        FAKE_DOCKER_MISSING_BINS: "codex",
      });
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("image my/img has no codex on its PATH");
      expect(existsSync(path.join(w.repo, ".graph-execution"))).toBe(false);
    }));

  it("refuses a provider with no login to copy, before creating anything", () =>
    withWorld(async (w) => {
      const { tasks, spec } = await addTasks(w.repo);
      const res = await runCli(w, [tasks, "--spec", spec, "--provider", "claude", "--sandbox"]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("no claude login to copy into the sandbox: log in once, or set ANTHROPIC_API_KEY");
      expect((await dockerCalls(w.log)).some((c) => c.argv[0] === "create")).toBe(false);
    }));

  it("builds the image, creates the container, copies the login and starts it", () =>
    withWorld(async (w) => {
      const { tasks, spec } = await addTasks(w.repo);
      await mkdir(path.join(w.home, ".claude"), { recursive: true });
      await writeFile(path.join(w.home, ".claude", ".credentials.json"), '{"login":true}');
      const child = runCli(w, [tasks, "--spec", spec, "--provider", "claude", "--sandbox", "--web"]);
      await answerReady(w);
      const res = await child;
      expect(res.exitCode, res.stderr).toBe(0);

      const calls = await dockerCalls(w.log);
      const verbs = calls.map((c) => c.argv[0]);
      expect(verbs.indexOf("build")).toBeGreaterThan(-1);
      expect(verbs.indexOf("build")).toBeLessThan(verbs.indexOf("create"));
      expect(verbs.indexOf("create")).toBeLessThan(verbs.indexOf("cp"));
      expect(verbs.indexOf("cp")).toBeLessThan(verbs.indexOf("start"));
      const create = calls.find((c) => c.argv[0] === "create")!.argv;
      const realRepo = await gitOut(w.repo, ["rev-parse", "--show-toplevel"]);
      expect(create).toEqual(expect.arrayContaining(["--init", "--user", "-v", `${realRepo}:${realRepo}`, "--security-opt", "no-new-privileges"]));
      const port = /^127\.0\.0\.1:(\d+):7600$/.exec(create[create.indexOf("-p") + 1]!)?.[1];
      expect(port).toBeDefined();
      const env = envOf(create);
      expect(env.some((e) => e.startsWith("GRAPH_EXECUTION_READY_FILE="))).toBe(true);
      expect(env).toContain(`GRAPH_EXECUTION_WEB_PUBLIC_PORT=${port}`);
      expect(env.some((e) => e.startsWith("GM_"))).toBe(false);
      expect(create.slice(-1)).toEqual(["--web-serve"]);
      expect(create).not.toContain("--sandbox");
      expect(create).not.toContain("--web");

      const copy = calls.find((c) => c.argv[0] === "cp")!;
      expect(copy.argv.slice(0, 2)).toEqual(["cp", "-a"]);
      expect(copy.listing).toEqual([".claude/", ".claude/.credentials.json"]);
      const staged = copy.argv[2]!.replace(/\/\.$/, "");
      expect(existsSync(staged)).toBe(false);
      const name = create[create.indexOf("--name") + 1]!;
      expect(await readFile(path.join(`${w.state}.d`, name, "home", ".claude", ".credentials.json"), "utf8")).toBe('{"login":true}');

      const runId = name.replace(/^ge-sbx-/, "");
      const sandbox = JSON.parse(await readFile(path.join(w.repo, ".graph-execution", runId, SANDBOX_FILE), "utf8"));
      expect(sandbox).toMatchObject({ container: name, url: `http://127.0.0.1:${port}/`, hostname: expect.stringMatching(/^sbx-[0-9a-f]{8}$/) });
      expect(res.stdout).toContain(`Run ${runId} started in a sandbox: http://127.0.0.1:${port}/?token=`);

      // The tag exists now: a second start builds nothing.
      await rm(w.log);
      const again = runCli(w, [tasks, "--spec", spec, "--provider", "claude", "--sandbox"]);
      await answerReady(w);
      expect((await again).exitCode).toBe(0);
      expect((await dockerCalls(w.log)).some((c) => c.argv[0] === "build")).toBe(false);
    }));

  it("removes the container and exits 2 when it exits before its page is up", () =>
    withWorld(async (w) => {
      const { tasks, spec } = await addTasks(w.repo);
      const res = await runCli(w, [tasks, "--spec", spec, "--provider", "fake", "--sandbox"], {
        FAKE_DOCKER_EXEC: "1",
        FAKE_DOCKER_IMAGE_PATH: "/nowhere",
      });
      // The container's node runs with PATH=/nowhere: git is missing and the run fails before its page.
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("the sandbox exited");
      const calls = await dockerCalls(w.log);
      expect(calls.some((c) => c.argv[0] === "logs")).toBe(true);
      expect(calls.some((c) => c.argv[0] === "rm" && c.argv.includes("-f"))).toBe(true);
    }));

  it("runs the diamond end to end in exec mode: applied, listed, opened, then not live once exited", () =>
    withWorld(async (w) => {
      const { tasks, spec } = await addTasks(w.repo);
      const res = await runCli(
        w,
        [tasks, "--spec", spec, "--provider", "fake", "--sandbox", "--sandbox-base", "node:22-bookworm", "--sandbox-line", "RUN echo hi"],
        { FAKE_DOCKER_EXEC: "1" },
      );
      expect(res.exitCode, res.stdout + res.stderr).toBe(0);
      const calls = await dockerCalls(w.log);
      const build = calls.find((c) => c.argv[0] === "build")!;
      expect(build.stdin).toMatch(/^FROM node:22-bookworm\n/);
      expect(build.stdin).toContain("\nRUN echo hi\n");
      const runId = /Run (\S+) started in a sandbox/.exec(res.stdout)![1]!;
      const url = /(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(res.stdout)![1]!;
      const runDir = path.join(w.repo, ".graph-execution", runId);

      let state: { status?: string; sandbox?: Record<string, unknown> } = {};
      for (let i = 0; i < 300 && state.status !== "applied"; i++) {
        await new Promise((r) => setTimeout(r, 100));
        state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8").catch(() => "{}"));
      }
      expect(state.status).toBe("applied");
      expect(state.sandbox).toMatchObject({ base: "node:22-bookworm", lines: ["RUN echo hi"], image: expect.stringMatching(/^graph-execution-sandbox:/) });
      // The token sets the page's cookie, which then opens the page.
      const first = await fetch(url, { redirect: "manual" });
      expect(first.status).toBe(302);
      const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
      expect((await fetch(url.replace(/\?token=.*$/, ""), { headers: { cookie } })).status).toBe(200);

      const list = await runCli(w, ["list"]);
      expect(list.stdout).toMatch(new RegExp(`${runId}\\s+running.*\\(sandbox ge-sbx-${runId}\\)`));
      const open = await runCli(w, ["open", "--run", runId]);
      expect(open.exitCode, open.stderr).toBe(0);
      expect(open.stdout).toContain(`Run ${runId}: ${url}`);

      // The container exits.
      const docker = await readFakeDockerState(w.state);
      const c = docker.containers[`ge-sbx-${runId}`]!;
      process.kill(-c.pid!, "SIGKILL");
      c.running = false;
      await writeFile(w.state, JSON.stringify(docker));
      const after = await runCli(w, ["list"]);
      expect(after.stdout).toMatch(new RegExp(`${runId}\\s+applied`));
      expect(after.stdout).not.toContain("(sandbox");
      const closed = await runCli(w, ["open", "--run", runId]);
      expect(closed.exitCode).toBe(2);
      expect(closed.stderr).toContain("has no live page");

      // clean removes the exited container with the run.
      const clean = await runCli(w, ["clean", runId, "--yes"]);
      expect(clean.exitCode, clean.stdout + clean.stderr).toBe(0);
      expect((await readFakeDockerState(w.state)).containers[`ge-sbx-${runId}`]).toBeUndefined();
    }), 90_000);

  it("resumes with --resume --sandbox: refused while the old container runs, else a new one takes the lock over", () =>
    withWorld(async (w) => {
      const { tasks, spec } = await addTasks(w.repo);
      const script = path.join(w.work, "fake-script.json");
      await writeFile(script, JSON.stringify({ "task:1": { attempts: [{ commit: false, write: {} }, { commit: false, write: {} }, { commit: false, write: {} }] } }));
      // An unfinished sandboxed run, as a container would have left it.
      const first = await runCli(w, [tasks, "--spec", spec, "--provider", "fake"], {
        GRAPH_EXECUTION_FAKE_SCRIPT: script,
        GRAPH_EXECUTION_SANDBOX: "1",
        GRAPH_EXECUTION_SANDBOX_IMAGE: "my/img",
      });
      expect(first.exitCode).toBe(2);
      const runId = /Run (\S+):/.exec(first.stdout)![1]!;
      const runDir = path.join(w.repo, ".graph-execution", runId);
      const name = `ge-sbx-${runId}`;
      await writeFile(
        path.join(runDir, SANDBOX_FILE),
        JSON.stringify({ container: name, image: "my/img", hostname: "sbx-deadbeef", url: "http://127.0.0.1:1/", token: "t", host: "h" }),
      );
      await writeFile(w.state, JSON.stringify({ images: ["my/img"], containers: { [name]: { name, env: [], mounts: [], ports: [], image: "my/img", cmd: [], started: true, running: true } } }));

      const plain = await runCli(w, ["--resume", "--run", runId]);
      expect(plain.exitCode).toBe(2);
      expect(plain.stderr).toContain(`run ${runId} ran in a sandbox: resume it with graph-execution --resume --run ${runId} --sandbox, or from graph-manager`);

      const busy = await runCli(w, ["--resume", "--run", runId, "--sandbox"]);
      expect(busy.exitCode).toBe(2);
      expect(busy.stderr).toContain("the run's sandbox is still running");
      const list = await runCli(w, ["list"]);
      expect(list.stdout).toContain(`(sandbox ${name})`);

      const docker = await readFakeDockerState(w.state);
      docker.containers[name]!.running = false;
      await writeFile(w.state, JSON.stringify(docker));
      await rm(w.log, { force: true });
      const child = runCli(w, ["--resume", "--run", runId, "--sandbox"], { GRAPH_EXECUTION_FAKE_SCRIPT: script });
      await answerReady(w);
      const res = await child;
      expect(res.exitCode, res.stderr).toBe(0);
      const calls = await dockerCalls(w.log);
      expect(calls.some((c) => c.argv[0] === "rm")).toBe(true);
      const create = calls.find((c) => c.argv[0] === "create")!.argv;
      expect(envOf(create)).toContain("GRAPH_EXECUTION_TAKE_LOCK_FROM=sbx-deadbeef");
      expect(create.slice(create.indexOf("my/img") + 1)).toEqual(["node", "/opt/graph-execution/dist/cli.js", "--resume", "--run", runId, "--web-serve"]);
      const sandbox = JSON.parse(await readFile(path.join(runDir, SANDBOX_FILE), "utf8"));
      expect(sandbox.hostname).not.toBe("sbx-deadbeef");
      expect(sandbox.token).not.toBe("t");
    }));
});
