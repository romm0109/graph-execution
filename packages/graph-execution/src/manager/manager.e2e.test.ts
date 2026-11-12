// `graph-execution manager` end to end, on the built CLI. The parts that start the manager need the bundle
// (dist/manager/server, made by the root `npm run build`; vitest.global-setup.ts bundles when the manager is built).
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa, type ResultPromise } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const cli = path.join(root, "dist", "cli.js");
const bundled = existsSync(path.join(root, "dist", "manager", "server", "main.js"));

let tmp: string;
const children: ResultPromise[] = [];

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "ge-manager-e2e-"));
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.pid !== undefined) child.kill("SIGKILL");
    await child.catch(() => undefined);
  }
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** The environment without the user's GM_* settings, with a home of its own: nothing reaches the real machine. */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GM_") && key !== "CLAUDE_CONFIG_DIR" && key !== "GRAPH_EXECUTION_NO_OPEN") env[key] = value;
  }
  const home = path.join(tmp, "home");
  return { ...env, HOME: home, USERPROFILE: home, GM_DOCKER_SOCKET: path.join(tmp, "none.sock"), ...extra };
}

function spawn(args: string[], env: Record<string, string> = {}): ResultPromise<{ env: Record<string, string>; extendEnv: false; reject: false }> {
  const child = execa("node", [cli, "manager", ...args], { cwd: tmp, env: cleanEnv(env), extendEnv: false, reject: false });
  children.push(child as unknown as ResultPromise);
  return child;
}

const dirs = (): string[] => ["--data-dir", path.join(tmp, "d"), "--workspaces-dir", path.join(tmp, "w")];

/** Starts the manager on a free port and waits for its two lines. */
async function start(env: Record<string, string> = {}) {
  const child = spawn(["--no-open", "--port", "0", ...dirs()], env);
  let out = "";
  const lines = await new Promise<{ url: string; passwordLine: string }>((resolve, reject) => {
    const check = (): void => {
      const url = /^graph-manager listening on (http:\/\/\S+)$/m.exec(out)?.[1];
      const passwordLine = /^Password: .*$/m.exec(out)?.[0];
      // The password line is complete once its newline arrived.
      if (url && passwordLine && out.includes(`${passwordLine}\n`)) resolve({ url, passwordLine: passwordLine.trimEnd() });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      check();
    });
    void child.then((res) => reject(new Error(`the manager exited (${res.exitCode}): ${res.stdout}\n${res.stderr}`)));
  });
  return { child, ...lines, out: () => out };
}

const login = (url: string, password: string): Promise<Response> =>
  fetch(`${url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });

const run = (args: string[]) => execa("node", [cli, ...args], { cwd: root, reject: false });

describe("graph-execution manager", () => {
  it("is listed in --help, and its own --help lists its options", async () => {
    const top = await run(["--help"]);
    expect(top.exitCode).toBe(0);
    expect(top.stdout).toMatch(/^\s+manager\b.*Start graph-manager/m);

    const res = await run(["manager", "--help"]);
    expect(res.exitCode).toBe(0);
    for (const option of ["--port", "--host", "--data-dir", "--workspaces-dir", "--no-open"]) expect(res.stdout).toContain(option);
  });

  it("refuses --web", async () => {
    const res = await run(["manager", "--web"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("unknown option '--web'");
  });

  it.skipIf(bundled)("exits 2 when graph-manager is not part of this build", async () => {
    const res = await spawn(["--no-open"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("error: graph-manager is not part of this build: run npm run build at the repository root");
  });

  describe.skipIf(!bundled)("with the bundled graph-manager", () => {
    it("starts with a generated password, serves the UI and the login, and keeps the password", async () => {
      const file = path.join(tmp, "d", "password");
      const first = await start();
      expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
      expect(first.out().indexOf("graph-manager listening on")).toBeLessThan(first.out().indexOf("Password: "));
      const password = (await readFile(file, "utf8")).trim();
      expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(first.passwordLine).toBe(`Password: ${password} (saved in ${file})`);
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

      expect((await fetch(`${first.url}/healthz`)).status).toBe(200);
      expect((await login(first.url, password)).status).toBe(204);
      expect((await login(first.url, `${password}x`)).status).toBe(401);
      const page = await fetch(`${first.url}/`);
      expect(page.status).toBe(200);
      expect((await page.text()).toLowerCase()).toMatch(/<div id="root"|<!doctype html/);

      // Windows has no SIGINT one process can send another: there the child is killed in afterEach.
      if (process.platform !== "win32") {
        first.child.kill("SIGINT");
        const res = await first.child;
        expect(res.exitCode).toBe(0);
      } else {
        first.child.kill();
        await first.child;
      }

      const second = await start();
      expect(second.passwordLine).toBe(`Password: ${password} (saved in ${file})`);
    }, 60_000);

    it.skipIf(process.platform === "win32")("ends with exit code 0 on SIGTERM", async () => {
      const { child } = await start();
      child.kill("SIGTERM");
      expect((await child).exitCode).toBe(0);
    }, 30_000);

    it("with GM_PASSWORD prints no password and writes no file", async () => {
      const { url, passwordLine, out } = await start({ GM_PASSWORD: "pw" });
      expect(passwordLine).toBe("Password: from GM_PASSWORD");
      expect(out()).not.toMatch(/\bpw\b/);
      expect(existsSync(path.join(tmp, "d", "password"))).toBe(false);
      expect((await login(url, "pw")).status).toBe(204);
      expect((await login(url, "nope")).status).toBe(401);
    }, 30_000);

    it("exits 1 when the port is in use", async () => {
      const holder = net.createServer();
      await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
      try {
        const port = (holder.address() as net.AddressInfo).port;
        const res = await spawn(["--no-open", "--port", String(port), ...dirs()]);
        expect(res.exitCode).toBe(1);
        expect(res.stderr).toContain(`port ${port} is already in use: pass --port or set GM_PORT`);
        expect(res.stdout).not.toContain("listening on");
      } finally {
        await new Promise<void>((resolve) => holder.close(() => resolve()));
      }
    }, 30_000);
  });
});
