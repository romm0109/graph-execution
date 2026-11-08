import { describe, expect, it, afterEach } from "vitest";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SCROLLBACK_MAX, TerminalManager, TerminalRunningError, terminalEnv, writeGraphExecutionShim, writeMcpShim } from "./terminals.js";
import { tempDir } from "./test-helpers.js";

const skip = process.platform === "win32";
let mgr: TerminalManager | undefined;
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  mgr?.disposeAll();
  mgr = undefined;
  await cleanup?.();
  cleanup = undefined;
});

async function setup(env?: NodeJS.ProcessEnv, binDir?: string) {
  const t = await tempDir();
  cleanup = t.cleanup;
  mgr = new TerminalManager({ workspacesDir: t.dir, env, binDir: binDir?.replace("$DIR", t.dir) });
  return { dir: t.dir, mgr };
}

function run(m: TerminalManager, cwd: string, command: string[]) {
  const info = m.create({ cwd, command });
  let out = "";
  const exited = new Promise<number>((resolve) => {
    const att = m.attach(info.id, (d) => (out += d), resolve);
    out += att.replay;
  });
  return { info, exited, output: () => out };
}

describe.skipIf(skip)("TerminalManager", () => {
  it("streams output, records the exit code and replays after exit", async () => {
    const { dir, mgr } = await setup();
    const t = run(mgr, dir, ["/bin/sh", "-c", "printf hi; sleep 0.2; exit 3"]);
    expect(t.info.id).toBe("t1");
    expect(await t.exited).toBe(3);
    expect(t.output()).toContain("hi");
    const info = mgr.get(t.info.id);
    expect(info?.status).toBe("exited");
    expect(info?.exitCode).toBe(3);
    expect(mgr.list()).toHaveLength(1);

    let exitCode: number | undefined;
    const att = mgr.attach(t.info.id, () => {}, (c) => (exitCode = c));
    expect(att.replay).toContain("hi");
    await new Promise((r) => setTimeout(r, 10));
    expect(exitCode).toBe(3);
  });

  it("reports working while output flows, then idle", async () => {
    const { dir, mgr } = await setup();
    const info = mgr.create({ cwd: dir, command: ["/bin/sh", "-c", "printf x; sleep 30"] });
    expect(mgr.get(info.id)?.status).toBe("idle");
    await new Promise<void>((resolve) => mgr.attach(info.id, () => resolve(), () => {}));
    expect(mgr.get(info.id)?.status).toBe("working");
    expect(mgr.get(info.id)?.workingSince).toBeTruthy();
    mgr.kill(info.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(mgr.get(info.id)?.status).toBe("exited");
    mgr.remove(info.id);
    expect(mgr.list()).toEqual([]);
  });

  it("sets the handoff env and strips GM_PASSWORD", async () => {
    const { dir, mgr } = await setup({ ...process.env, GM_PASSWORD: "secret", GRAPH_EXECUTION_RUN_ID: "r1" });
    const t = run(mgr, dir, ["/bin/sh", "-c", 'echo $GRAPH_EXECUTION_HANDOFF-${GM_PASSWORD:-none}-${GRAPH_EXECUTION_RUN_ID:-none}-$SSH_CONNECTION-$TERM']);
    expect(await t.exited).toBe(0);
    expect(t.output()).toContain("detached-none-none-1-xterm-256color");
  });

  it("sets GRAPH_EXECUTION_REVIEWERS only when given a reviewers file", () => {
    expect(terminalEnv({ PATH: "/usr/bin" }, undefined, "/d/reviewers.json").GRAPH_EXECUTION_REVIEWERS).toBe("/d/reviewers.json");
    expect(terminalEnv({ PATH: "/usr/bin" })).not.toHaveProperty("GRAPH_EXECUTION_REVIEWERS");
  });

  it("strips a parent agent's session variables but keeps agent settings and keys", () => {
    const env = terminalEnv({
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "11111111-2222-3333-4444-555555555555",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_REMOTE_SESSION_ID: "cse_1",
      CCR_SESSION_PROFILE: "x",
      CODEX_SANDBOX: "seatbelt",
      CODEX_SANDBOX_NETWORK_DISABLED: "1",
      OPENCODE: "1",
      QWEN_CODE: "1",
      CLAUDE_CONFIG_DIR: "/cfg",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "o",
      CODEX_HOME: "/codex",
    });
    for (const k of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_REMOTE_SESSION_ID", "CCR_SESSION_PROFILE", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "OPENCODE", "QWEN_CODE"]) {
      expect(env).not.toHaveProperty(k);
    }
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/cfg",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "o",
      CODEX_HOME: "/codex",
    });
  });

  it("caps the scrollback at 256 KiB", async () => {
    const { dir, mgr } = await setup();
    const t = run(mgr, dir, ["/bin/sh", "-c", "head -c 409600 /dev/zero | tr '\\0' a"]);
    expect(await t.exited).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    const replay = mgr.attach(t.info.id, () => {}, () => {}).replay;
    expect(replay.length).toBeLessThanOrEqual(SCROLLBACK_MAX);
    expect(replay.length).toBeGreaterThan(SCROLLBACK_MAX / 2);
  });

  it("puts a graph-execution shim on PATH", async () => {
    const { dir, mgr } = await setup(process.env, "$DIR/bin");
    const cli = path.join(dir, "cli.js");
    await writeFile(cli, "console.log('engine', process.argv.slice(2).join(' '))");
    expect(writeGraphExecutionShim(path.join(dir, "bin"), cli)).toBe(true);
    expect(writeGraphExecutionShim(path.join(dir, "bin2"), "graph-execution")).toBe(false);
    const t = run(mgr, dir, ["/bin/sh", "-c", "graph-execution --version"]);
    expect(await t.exited).toBe(0);
    expect(t.output()).toContain("engine --version");
  });

  it("writes the shim form with graph-manager's shim.js", async () => {
    const { dir } = await setup();
    const cli = path.join(dir, "cli.js");
    const shimJs = path.join(dir, "shim.js");
    await writeFile(cli, "");
    await writeFile(shimJs, "console.log('shim', process.env.GM_ENGINE_BIN, process.argv.slice(2).join(' '))");
    expect(writeGraphExecutionShim(path.join(dir, "bin"), cli, shimJs)).toBe(true);
    expect(await readFile(path.join(dir, "bin", "graph-execution"), "utf8")).toBe(
      `#!/bin/sh\nGM_ENGINE_BIN=${JSON.stringify(cli)} exec node ${JSON.stringify(shimJs)} "$@"\n`,
    );
    // A shim.js that does not exist (tests run from src/) keeps the direct form.
    expect(writeGraphExecutionShim(path.join(dir, "bin2"), cli, path.join(dir, "missing.js"))).toBe(true);
    expect(await readFile(path.join(dir, "bin2", "graph-execution"), "utf8")).toBe(`#!/bin/sh\nexec node ${JSON.stringify(cli)} "$@"\n`);
  });

  it("adds extraEnv to every terminal and drops an outer server's internal token", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    let url = "";
    mgr = new TerminalManager({
      workspacesDir: t.dir,
      env: { ...process.env, GM_INTERNAL_TOKEN: "outer", GM_INTERNAL_URL: "http://outer" },
      extraEnv: () => ({ GM_INTERNAL_TOKEN: "inner", ...(url ? { GM_INTERNAL_URL: url } : {}) }),
    });
    const a = run(mgr, t.dir, ["/bin/sh", "-c", 'echo "tok=$GM_INTERNAL_TOKEN url=$GM_INTERNAL_URL."']);
    expect(await a.exited).toBe(0);
    expect(a.output()).toContain("tok=inner url=.");
    url = "http://127.0.0.1:1234";
    const b = run(mgr, t.dir, ["/bin/sh", "-c", 'echo "url=$GM_INTERNAL_URL."']);
    expect(await b.exited).toBe(0);
    expect(b.output()).toContain("url=http://127.0.0.1:1234.");
  });

  it("sets GM_TERMINAL_ID to the terminal's own id, replacing an inherited one, also after a restart", async () => {
    const { dir, mgr } = await setup({ ...process.env, GM_TERMINAL_ID: "outer" });
    const a = run(mgr, dir, ["/bin/sh", "-c", "echo id=$GM_TERMINAL_ID"]);
    expect(await a.exited).toBe(0);
    expect(a.output()).toContain("id=t1");
    expect(a.output()).not.toContain("outer");
    const b = run(mgr, dir, ["/bin/sh", "-c", "echo id=$GM_TERMINAL_ID"]);
    expect(await b.exited).toBe(0);
    expect(b.output()).toContain("id=t2");

    let out = "";
    mgr.attach("t1", (d) => (out += d), () => {});
    mgr.restart("t1");
    for (let i = 0; i < 100 && !out.includes("id="); i++) await new Promise((r) => setTimeout(r, 20));
    expect(out).toContain("id=t1");
  });

  it("restarts an exited terminal: a new process, the old scrollback, and attached listeners keep receiving", async () => {
    const { dir, mgr } = await setup();
    const info = mgr.create({ cwd: dir, command: ["/bin/sh"] });
    let out = "";
    const exits: number[] = [];
    let restarts = 0;
    const exited = new Promise<void>((resolve) => {
      mgr.attach(
        info.id,
        (d) => (out += d),
        (c) => {
          exits.push(c);
          resolve();
        },
        () => restarts++,
      );
    });
    expect(mgr.get(info.id)?.process).toBeTruthy();
    expect(() => mgr.restart(info.id)).toThrow(TerminalRunningError);
    mgr.attach(info.id, () => {}, () => {}).write("echo before-$((1+1)); exit 3\r");
    await exited;
    expect(exits).toEqual([3]);
    expect(mgr.get(info.id)?.process).toBeUndefined();

    const after = mgr.restart(info.id);
    expect(after?.status).not.toBe("exited");
    expect(after?.exitCode).toBeUndefined();
    expect(after?.cwd).toBe(dir);
    expect(restarts).toBe(1);
    expect(mgr.restart("t999")).toBeUndefined();

    const att = mgr.attach(info.id, () => {}, () => {});
    expect(att.replay).toContain("before-2");
    expect(att.replay.endsWith("\r\n")).toBe(true);
    const got = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (out.includes("after-7")) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
    });
    att.write("echo after-$((3+4))\r");
    await got;
    att.write("exit 0\r");
    await new Promise((r) => setTimeout(r, 300));
    expect(mgr.get(info.id)?.exitCode).toBe(0);
  });

  it("adds a terminal's own env, types its input at spawn and after a restart, and reports its agent", async () => {
    const { dir, mgr } = await setup();
    const info = mgr.create({ cwd: dir, agent: "codex", env: { FOO: "bar" }, input: "echo foo=$FOO\r" });
    expect(info.agent).toBe("codex");
    expect(mgr.list()[0]?.agent).toBe("codex");
    let out = "";
    let exited = false;
    mgr.attach(info.id, (d) => (out += d), () => (exited = true));
    const count = () => out.split("foo=bar").length - 1;
    const waitFor = async (cond: () => boolean) => {
      for (let i = 0; i < 250 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
    };
    await waitFor(() => count() >= 1);
    expect(count()).toBe(1);
    mgr.kill(info.id);
    await waitFor(() => exited);
    expect(mgr.restart(info.id)?.agent).toBe("codex");
    await waitFor(() => count() >= 2);
    expect(count()).toBe(2);
  });

  it("names the foreground process and renames", async () => {
    const { dir, mgr } = await setup();
    const info = mgr.create({ cwd: dir, command: ["/bin/sh", "-c", "sleep 30"] });
    await new Promise((r) => setTimeout(r, 200));
    const p = mgr.get(info.id)?.process;
    expect(typeof p).toBe("string");
    expect(p).not.toBe("");
    expect(mgr.rename(info.id, "  build  ")?.title).toBe("build");
    expect(mgr.rename("t999", "x")).toBeUndefined();
  });
});

describe.skipIf(skip)("writeMcpShim", () => {
  it("writes an executable graph-manager-mcp running the given file, or nothing when it is missing", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    const js = path.join(t.dir, "mcp.js");
    await writeFile(js, "");
    expect(writeMcpShim(path.join(t.dir, "bin"), js)).toBe(true);
    const file = path.join(t.dir, "bin", "graph-manager-mcp");
    const content = await readFile(file, "utf8");
    expect(content).toContain("exec node");
    expect(content).toContain(JSON.stringify(js));
    expect((await stat(file)).mode & 0o111).not.toBe(0);
    expect(writeMcpShim(path.join(t.dir, "bin2"), path.join(t.dir, "missing.js"))).toBe(false);
  });
});
