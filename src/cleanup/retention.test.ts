import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { retainRuns } from "./retention.js";
import { branch, makeRun, makeSuite } from "./scan.test.js";

let repo: string;
let lines: string[];
const log = (l: string): void => {
  lines.push(l);
};
const ids = Array.from({ length: 6 }, (_, i) => `2026010${i + 1}-000000-aaaa`);
const dir = (id: string) => path.join(repo, ".graph-execution", id);

beforeEach(async () => {
  repo = await tempRepo();
  lines = [];
  for (const id of ids) {
    await makeRun(repo, id, "applied");
    await branch(repo, `graph/${id}`);
  }
  await makeRun(repo, "20260201-000000-bbbb");
  await makeRun(repo, "20260202-000000-bbbb");
  await makeRun(repo, "20260203-000000-cccc", "done");
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("retainRuns", () => {
  it("deletes only the applied runs beyond keepRuns and hints at unfinished runs", async () => {
    await retainRuns(repo, 5, log);
    expect(existsSync(dir(ids[0]!))).toBe(false);
    expect(await gitOut(repo, ["branch", "--list", `graph/${ids[0]}`])).toBe("");
    for (const id of ids.slice(1)) expect(existsSync(dir(id))).toBe(true);
    for (const id of ["20260201-000000-bbbb", "20260202-000000-bbbb", "20260203-000000-cccc"]) expect(existsSync(dir(id))).toBe(true);
    expect(lines.some((l) => l.includes("cleaned up 1 old applied run"))).toBe(true);
    expect(lines.some((l) => l.includes("2 unfinished runs use"))).toBe(true);
  });

  it("keepRuns 0 deletes nothing", async () => {
    await retainRuns(repo, 0, log);
    for (const id of ids) expect(existsSync(dir(id))).toBe(true);
    expect(lines.some((l) => l.includes("cleaned up"))).toBe(false);
  });

  it("logs a warning instead of throwing when the scan fails", async () => {
    vi.resetModules();
    vi.doMock("./scan.js", () => ({ scan: () => Promise.reject(new Error("boom")) }));
    try {
      const { retainRuns: failing } = await import("./retention.js");
      await expect(failing(repo, 5, log)).resolves.toBeUndefined();
    } finally {
      vi.doUnmock("./scan.js");
      vi.resetModules();
    }
    expect(lines).toEqual(["warning: automatic cleanup failed: boom"]);
  });

  it("counts an applied suite with applied runs and deletes it with all its branches", async () => {
    for (const id of ids.slice(2)) await rm(dir(id), { recursive: true });
    const suiteDir = await makeSuite(repo, "20251201-000000-ab12", "applied", ["sf-1", "sf-2"]);
    for (const b of ["suite/20251201-000000-ab12", "graph/sf-1", "graph/sf-2", "graph-task/sf-1/1"]) await branch(repo, b);
    await retainRuns(repo, 2, log);
    expect(existsSync(suiteDir)).toBe(false);
    expect(await gitOut(repo, ["branch", "--list", "suite/*", "graph/sf-*", "graph-task/sf-*"])).toBe("");
    expect(existsSync(dir(ids[0]!))).toBe(true);
    expect(existsSync(dir(ids[1]!))).toBe(true);
  });
});
