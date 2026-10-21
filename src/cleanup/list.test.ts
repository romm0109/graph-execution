import { rm } from "node:fs/promises";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempRepo } from "../__fixtures__/repo.js";
import { EXIT_SUCCESS } from "../state/errors.js";
import { formatAge, formatSize } from "./format.js";
import { listRuns } from "./list.js";
import { branch, makeRun, makeSuite } from "./scan.test.js";

let repo: string;
beforeEach(async () => {
  repo = await tempRepo();
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("listRuns", () => {
  it("prints the table and the orphan summary", async () => {
    const child = execa(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
    child.catch(() => undefined);
    try {
      await makeRun(repo, "run-applied", "applied");
      await makeRun(repo, "run-live", "running", child.pid);
      await makeRun(repo, "run-stuck");
      await branch(repo, "graph/run-applied");
      await branch(repo, "graph/run-stuck");
      await branch(repo, "graph-task/run-stuck/1");
      await branch(repo, "graph/old");
      await branch(repo, "graph-task/old/1");
      const out: string[] = [];
      const code = await listRuns({ cwd: repo, out: (t) => out.push(t), now: new Date("2026-01-01T03:00:00.000Z") });
      expect(code).toBe(EXIT_SUCCESS);
      const text = out.join("\n");
      expect(out[0]).toMatch(/^RUN\s+STATUS\s+AGE\s+SIZE\s+BRANCHES$/);
      expect(out.find((l) => l.startsWith("run-stuck"))).toMatch(/unfinished\s+3h .*graph\/run-stuck, 1 task branch$/);
      expect(out.find((l) => l.startsWith("run-live"))).toContain(`(pid ${child.pid})`);
      expect(text).toContain("run-applied");
      expect(out.at(-1)).toBe("Orphan branches: 2 (graph/* 1, graph-task/* 1)");
    } finally {
      child.kill();
    }
  });

  it("handles an empty repo", async () => {
    const out: string[] = [];
    await listRuns({ cwd: repo, out: (t) => out.push(t) });
    expect(out[0]).toMatch(/^No runs in .*\.graph-execution$/);
    expect(out[1]).toBe("Orphan branches: none");
  });
});

describe("format", () => {
  it("formats sizes and ages", () => {
    expect(formatSize(512 * 1024)).toBe("512 KB");
    expect(formatSize(8.9 * 1024 * 1024)).toBe("8.9 MB");
    expect(formatSize(38 * 1024 * 1024)).toBe("38 MB");
    const now = new Date("2026-01-04T00:00:00Z");
    expect(formatAge("2026-01-03T23:55:00Z", now)).toBe("5m");
    expect(formatAge("2026-01-03T22:00:00Z", now)).toBe("2h");
    expect(formatAge("2026-01-01T00:00:00Z", now)).toBe("3d");
  });

  it("lists a suite as one line", async () => {
    await makeSuite(repo, "20260102-000000-ab12", "applied", ["f-one", "f-two"]);
    for (const b of ["suite/20260102-000000-ab12", "graph/f-one", "graph/f-two"]) await branch(repo, b);
    const out: string[] = [];
    await listRuns({ cwd: repo, out: (t) => out.push(t), now: new Date("2026-01-02T00:00:00.000Z") });
    const lines = out.filter((l) => l.includes("f-one") || l.includes("suite-"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^suite-20260102-000000-ab12\s+applied\s+24h .*suite\/20260102-000000-ab12, 2 features$/);
    expect(out.at(-1)).toBe("Orphan branches: none");
  });
});
