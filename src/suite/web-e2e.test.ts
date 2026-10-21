import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const cli = path.join(root, "dist", "cli.js");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (fn: () => Promise<boolean> | boolean, ms = 60_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
};

interface Api {
  suite: { status: string; applied?: { files: number } };
  features: { name: string; status: string }[];
  allowed: { integrate: boolean; retry: string[] };
  running: boolean;
  reviewWaiting?: boolean;
}

async function addFeature(repo: string, name: string): Promise<void> {
  await mkdir(path.join(repo, name), { recursive: true });
  await writeFile(path.join(repo, name, `${name}1.json`), JSON.stringify({ id: `${name}1`, content: `Do ${name}.`, dependencies: [], validate: null }));
  await cp(path.join(root, "src", "__fixtures__", "spec.md"), path.join(repo, `PRD-${name}.md`));
}

/** Starts `suite --web` on two features where b's only task fails 3 times; runs `fn` with the page URL. */
async function withWebSuite(fn: (url: string, repo: string, script: string, suiteDir: string) => Promise<void>, extraArgs: string[] = [], scriptBody: object | undefined = undefined): Promise<void> {
  const repo = await tempRepo();
  let pid: number | undefined;
  try {
    await addFeature(repo, "a");
    await addFeature(repo, "b");
    await gitOut(repo, ["add", "-A"]);
    await gitOut(repo, ["commit", "-q", "-m", "features"]);
    const fail = { commit: false, write: {} };
    const script = path.join(repo, ".git", "fake-script.json");
    await writeFile(script, JSON.stringify(scriptBody ?? { "task:b1": { attempts: [fail, fail, fail] } }));
    const res = await execa("node", [cli, "suite", "--feature", "a:PRD-a.md", "--feature", "b:PRD-b.md", "--provider", "fake", "--concurrency", "2", "--web", ...extraArgs], {
      cwd: repo,
      reject: false,
      timeout: 30_000,
      env: { GRAPH_EXECUTION_HANDOFF: "detached", SSH_CONNECTION: "1 2 3 4", GRAPH_EXECUTION_FAKE_SCRIPT: script },
    });
    expect(res.exitCode).toBe(0);
    const m = /Suite (\S+) started: (http:\/\/127\.0\.0\.1:(\d+)\/)/.exec(res.stdout);
    expect(m).not.toBeNull();
    const [, suiteId, url] = m!;
    const suiteDir = path.join(repo, ".graph-execution", suiteId!);
    const webJson = path.join(suiteDir, "web.json");
    pid = (JSON.parse(await readFile(webJson, "utf8")) as { pid: number }).pid;
    await fn(url!, repo, script, suiteDir);
    const close = await fetch(`${url}close`, { method: "POST", headers: { origin: url!.slice(0, -1) } });
    expect(close.status).toBe(200);
    await until(() => !existsSync(webJson) && !alive(pid!));
  } finally {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const api = async (url: string): Promise<Api> => (await (await fetch(`${url}api/suite`)).json()) as Api;
const statusOf = (a: Api, name: string): string | undefined => a.features.find((f) => f.name === name)?.status;
const post = (url: string, p: string): Promise<Response> => fetch(`${url}${p}`, { method: "POST", headers: { origin: url.slice(0, -1) } });

describe("suite --web", () => {
  it("excludes the failed feature on Start integration and applies the rest", async () => {
    await withWebSuite(async (url) => {
      await until(async () => {
        const a = await api(url);
        return statusOf(a, "b") === "failed" && statusOf(a, "a") === "done" && a.allowed.integrate;
      });
      expect((await post(url, "api/integration/start")).status).toBe(200);
      await until(async () => !(await api(url)).running);
      const a = await api(url);
      expect(statusOf(a, "b")).toBe("excluded");
      expect(a.suite.status).toBe("applied");
    });
  }, 120_000);

  it("retries a failed feature after the script is fixed, then applies", async () => {
    await withWebSuite(async (url, _repo, script) => {
      await until(async () => (await api(url)).allowed.retry.includes("b"));
      await writeFile(script, "{}");
      expect((await post(url, "api/features/b/retry")).status).toBe(200);
      await until(async () => !(await api(url)).running);
      const a = await api(url);
      expect(statusOf(a, "b")).toBe("done");
      expect(a.suite.status).toBe("applied");
    });
  }, 120_000);
});

describe("suite --web --human-review", () => {
  const reviewed = async (url: string): Promise<void> => {
    await until(async () => (await api(url)).reviewWaiting === true);
    const info = (await (await fetch(`${url}api/review`)).json()) as { files: { path: string }[] };
    expect(info.files.length).toBeGreaterThan(0);
  };
  const send = (url: string, p: string, body: object): Promise<Response> =>
    fetch(`${url}${p}`, { method: "POST", headers: { origin: url.slice(0, -1), "content-type": "application/json" }, body: JSON.stringify(body) });

  it("requests changes, pauses again, then applies", async () => {
    await withWebSuite(
      async (url, repo, _script, suiteDir) => {
        await reviewed(url);
        expect((await send(url, "api/review/comments", { body: "rename things" })).status).toBe(201);
        expect((await send(url, "api/review/changes", {})).status).toBe(200);
        // The suite leaves the wait and comes back to it after the fixer, validation and e2e review ran.
        await until(async () => (await api(url)).reviewWaiting !== true);
        await until(async () => (await api(url)).reviewWaiting === true);
        const branch = `suite/${path.basename(suiteDir).slice("suite-".length)}`;
        expect(await gitOut(repo, ["log", "--format=%s", branch])).toContain("fake: fixer:fix-r");
        expect((await send(url, "api/review/apply", {})).status).toBe(200);
        await until(async () => !(await api(url)).running);
        const a = await api(url);
        expect(a.suite.status).toBe("applied");
        expect(await gitOut(repo, ["status", "--porcelain"])).not.toBe("");
      },
      ["--human-review"],
      {},
    );
  }, 180_000);

  it("ends done on Drop without applying", async () => {
    await withWebSuite(
      async (url, repo) => {
        await reviewed(url);
        const before = await gitOut(repo, ["status", "--porcelain"]);
        expect((await send(url, "api/review/drop", {})).status).toBe(200);
        await until(async () => !(await api(url)).running);
        expect((await api(url)).suite.status).toBe("done");
        expect(await gitOut(repo, ["status", "--porcelain"])).toBe(before);
      },
      ["--human-review"],
      {},
    );
  }, 180_000);
});
