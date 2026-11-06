import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { tempRepo } from "../__fixtures__/repo.js";
import { launchWeb } from "./launch.js";

const fixtures = fileURLToPath(new URL("../__fixtures__", import.meta.url));
const tasksDir = path.join(fixtures, "diamond");
const spec = path.join(fixtures, "spec.md");

async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const repo = await tempRepo();
  try {
    await fn(repo);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function setup(repo: string, over: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    handoff: vi.fn(async () => ({ ok: true as const, step: 0 })),
    waitForReady: vi.fn(async () => ({ ok: true as const, url: "http://127.0.0.1:5555/", runId: "r1", pid: 1 })),
    open: vi.fn(async () => true),
    out: (t: string) => out.push(t),
    err: (t: string) => err.push(t),
    ...over,
  };
  const args = [tasksDir, "--spec", spec, "--provider", "fake"];
  const launch = (env: NodeJS.ProcessEnv = {}) =>
    launchWeb(
      {
        args,
        cwd: repo,
        env: { PATH: process.env.PATH, ...env },
        platform: "linux",
        preflight: { cwd: repo, tasksDir, spec, provider: "fake" },
      },
      deps as never,
    );
  return { out, err, deps, launch };
}

describe("launchWeb", () => {
  it("fails preflight without handing off or creating a run folder", () =>
    withRepo(async (repo) => {
      const t = setup(repo);
      await expect(
        launchWeb(
          { args: [], cwd: repo, env: {}, preflight: { cwd: repo, tasksDir, spec: "/no/such/spec", provider: "fake" } },
          t.deps as never,
        ),
      ).rejects.toThrow(/spec file not found/);
      expect(t.deps.handoff).not.toHaveBeenCalled();
      expect(existsSync(path.join(repo, ".graph-execution"))).toBe(false);
    }));

  it("exits 3 and prints the foreground command when the hand-off is blocked", () =>
    withRepo(async (repo) => {
      const t = setup(repo, { handoff: vi.fn(async () => ({ ok: false as const, reason: "nope" })) });
      expect(await t.launch()).toBe(3);
      const text = t.out.join("\n");
      expect(text).toContain("Could not start the run in the background (nope). Run this in a terminal:");
      expect(text).toContain(`cd '${repo}'`);
      expect(text).toContain(`graph-execution '${tasksDir}' '--spec' '${spec}' '--provider' 'fake'`);
    }));

  it("exits 2 with the log tail when the run never gets ready", () =>
    withRepo(async (repo) => {
      const t = setup(repo, { waitForReady: vi.fn(async () => ({ ok: false as const, log: "boom" })) });
      expect(await t.launch()).toBe(2);
      expect(t.err).toEqual(["error: the run did not start", "boom"]);
    }));

  it("opens the browser once when ready", () =>
    withRepo(async (repo) => {
      const t = setup(repo);
      expect(await t.launch()).toBe(0);
      expect(t.deps.open).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:5555/");
      expect(t.out).toEqual(["Started run r1 in the background: http://127.0.0.1:5555/"]);
    }));

  it("prints the URL and an ssh hint over SSH without opening a browser", () =>
    withRepo(async (repo) => {
      const t = setup(repo);
      expect(await t.launch({ SSH_CONNECTION: "1 2 3 4" })).toBe(0);
      expect(t.deps.open).not.toHaveBeenCalled();
      expect(t.out.join("\n")).toContain("Run r1 started: http://127.0.0.1:5555/");
      expect(t.out.join("\n")).toContain("ssh -L 5555:127.0.0.1:5555");
    }));

  it("prints the plain form when the browser cannot be opened", () =>
    withRepo(async (repo) => {
      const t = setup(repo, { open: vi.fn(async () => false) });
      expect(await t.launch()).toBe(0);
      expect(t.out).toEqual(["Run r1 started: http://127.0.0.1:5555/"]);
    }));
});
