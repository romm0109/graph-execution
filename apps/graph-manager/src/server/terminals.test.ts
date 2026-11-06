import { describe, expect, it, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { SCROLLBACK_MAX, TerminalManager, writeGraphExecutionShim } from "./terminals.js";
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
});
