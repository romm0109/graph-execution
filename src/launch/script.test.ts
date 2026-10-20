import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeLaunchScript } from "./script.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ge-launch-"));
});
afterEach(async () => {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});

describe("writeLaunchScript content", () => {
  const env = {
    PATH: "/usr/bin:/bin",
    Path: "C:\\Windows;C:\\bin",
    HOME: "/home/u",
    USERPROFILE: "C:\\Users\\u",
    GRAPH_EXECUTION_FOO: "it's",
    SECRET_TOKEN: "nope",
    OTHER: "x",
  };

  it("writes a POSIX script", async () => {
    const r = await writeLaunchScript({
      platform: "linux",
      env,
      cwd: "/work dir",
      execPath: "/usr/bin/node",
      cliPath: "/opt/cli.js",
      args: ["a b", "run"],
      tmpRoot: root,
    });
    expect(path.basename(r.script)).toBe("run.sh");
    expect(r.readyFile).toBe(path.join(r.dir, "ready.json"));
    expect(r.logFile).toBe(path.join(r.dir, "launch.log"));
    expect(((await stat(r.dir)).mode & 0o777).toString(8)).toBe("700");
    expect((await readFile(r.script, "utf8")).split("\n")).toEqual([
      "#!/bin/sh",
      "export PATH='/usr/bin:/bin'",
      "export GRAPH_EXECUTION_FOO='it'\\''s'",
      "export HOME='/home/u'",
      "export USERPROFILE='C:\\Users\\u'",
      `export GRAPH_EXECUTION_READY_FILE='${r.readyFile}'`,
      "cd '/work dir' || exit 1",
      `echo $$ > '${r.pidFile}'`,
      `exec '/usr/bin/node' '/opt/cli.js' 'a b' 'run' --web-serve >> '${r.logFile}' 2>&1`,
      "",
    ]);
  });

  it("writes a Windows script", async () => {
    const r = await writeLaunchScript({
      platform: "win32",
      env: Object.fromEntries(
        Object.entries(env).filter(([k]) => k !== "PATH"),
      ),
      cwd: "C:\\my dir\\",
      execPath: "C:\\node.exe",
      cliPath: "C:\\cli.js",
      args: ["100%"],
      tmpRoot: root,
    });
    expect(path.basename(r.script)).toBe("run.cmd");
    expect((await readFile(r.script, "utf8")).split("\r\n")).toEqual([
      "@echo off",
      "setlocal DisableDelayedExpansion",
      'set "PATH=C:\\Windows;C:\\bin"',
      'set "GRAPH_EXECUTION_FOO=it\'s"',
      'set "HOME=/home/u"',
      'set "USERPROFILE=C:\\Users\\u"',
      `set "GRAPH_EXECUTION_READY_FILE=${r.readyFile}"`,
      'cd /d "C:\\my dir\\\\"',
      `"C:\\node.exe" "C:\\cli.js" "100%%" --web-serve >> "${r.logFile}" 2>&1`,
      "",
    ]);
  });
});

describe("writeLaunchScript round trip", () => {
  const args = ["with space", "it's", "a&b", "100%", "wow!", "ünï", "(x) ^y"];

  it("runs the script with the exact argv, cwd and env", async () => {
    const cwd = path.join(root, "work dir 'q' & 100%");
    await mkdir(cwd);
    const out = path.join(root, "out.json");
    const cliPath = path.join(root, "cli.js");
    await writeFile(
      cliPath,
      `require("node:fs").writeFileSync(process.env.OUT_FILE, JSON.stringify({
        argv: process.argv.slice(2), cwd: process.cwd(),
        env: { foo: process.env.GRAPH_EXECUTION_FOO, ready: process.env.GRAPH_EXECUTION_READY_FILE, other: process.env.OTHER ?? null },
      }));
      console.log("to-stdout"); console.error("to-stderr");`,
    );
    const r = await writeLaunchScript({
      env: {
        ...process.env,
        GRAPH_EXECUTION_FOO: "it's 100% wow!",
        GRAPH_EXECUTION_OUT: "1",
        OUT_FILE: out,
        OTHER: "leak",
      },
      cwd,
      execPath: process.execPath,
      cliPath,
      args,
      tmpRoot: root,
    });
    // OUT_FILE is not copied by the script, so pass it through the child environment.
    const [cmd, cmdArgs] =
      process.platform === "win32"
        ? ["cmd", ["/c", r.script]]
        : ["sh", [r.script]];
    await execa(cmd, cmdArgs, { env: { OUT_FILE: out } });
    const got = JSON.parse(await readFile(out, "utf8"));
    expect(got.argv).toEqual([...args, "--web-serve"]);
    expect(await realpath(got.cwd)).toBe(await realpath(cwd));
    expect(got.env.foo).toBe("it's 100% wow!");
    expect(got.env.ready).toBe(r.readyFile);
    const log = await readFile(r.logFile, "utf8");
    expect(log).toContain("to-stdout");
    expect(log).toContain("to-stderr");
  });
});
