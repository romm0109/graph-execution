import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  LOCK_FILE,
  LockError,
  lockHolder,
  readLock,
  reviewStateSchema,
  computeHashes,
  initialReviewState,
  StateStore,
  taskStateSchema,
  type RunState,
} from "./state.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "graph-execution-state-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const initial = (): RunState => ({
  runId: "20260101-000000-abcd",
  provider: "fake",
  humanReview: false,
  startingCommit: "abc",
  integrationBranch: "graph/20260101-000000-abcd",
  specPath: "/spec.md",
  tasksDir: "/tasks",
  hashes: { config: "", tasks: "t", spec: "s", reviewers: "" },
  review: initialReviewState(),
  tasks: { "1": { status: "pending", attempts: 0 } },
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("StateStore", () => {
  it("saves atomically and loads back", async () => {
    const file = path.join(dir, "state.json");
    const store = new StateStore(file, initial());
    await store.update((s) => {
      s.tasks["1"] = { status: "merged", attempts: 1, mergeCommit: "def" };
    });
    expect(await readdir(dir)).toEqual(["state.json"]);
    expect((await StateStore.load(file)).state.tasks["1"]).toEqual({ status: "merged", attempts: 1, mergeCommit: "def" });
  });

  it("loads a state saved without status as undefined", async () => {
    const file = path.join(dir, "state.json");
    await writeFile(file, JSON.stringify(initial()));
    expect((await StateStore.load(file)).state.status).toBeUndefined();
  });

  it("round-trips a run status", async () => {
    const file = path.join(dir, "state.json");
    await new StateStore(file, { ...initial(), status: "applied" }).save();
    expect((await StateStore.load(file)).state.status).toBe("applied");
  });

  it("rejects an invalid run status", async () => {
    const file = path.join(dir, "state.json");
    await writeFile(file, JSON.stringify({ ...initial(), status: "bogus" }));
    await expect(StateStore.load(file)).rejects.toThrow();
  });

  it("loads a state saved without humanReview as false", async () => {
    const file = path.join(dir, "state.json");
    const old: Partial<RunState> = initial();
    delete old.humanReview;
    await writeFile(file, JSON.stringify(old));
    expect((await StateStore.load(file)).state.humanReview).toBe(false);
  });

  it("loads an old state without a reviewers hash, and reports keyed by any reviewer id", async () => {
    const file = path.join(dir, "state.json");
    const old = { ...initial(), hashes: { config: "", tasks: "t", spec: "s" }, review: { ...initialReviewState(), reports: { code: "x" } } };
    await writeFile(file, JSON.stringify(old));
    const { state } = await StateStore.load(file);
    expect(state.hashes.reviewers).toBe("");
    expect(state.review.reports).toEqual({ code: "x" });
    await writeFile(file, JSON.stringify({ ...old, review: { ...old.review, reports: { security: "y" } } }));
    expect((await StateStore.load(file)).state.review.reports).toEqual({ security: "y" });
  });

  it("refuses to save an invalid state", async () => {
    const store = new StateStore(path.join(dir, "state.json"), initial());
    (store.state.tasks["1"] as { status: string }).status = "bogus";
    await expect(store.save()).rejects.toThrow();
  });
});

describe("baseSha", () => {
  it("is optional: a task state without it still parses", () => {
    expect(taskStateSchema.parse({ status: "merged", attempts: 1 }).baseSha).toBeUndefined();
    expect(taskStateSchema.parse({ status: "running", attempts: 1, baseSha: "abc" }).baseSha).toBe("abc");
  });
});

describe("computeHashes tasks hash", () => {
  it("ignores test-plan.json but not task files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ge-hash-"));
    try {
      await writeFile(path.join(dir, "1.json"), '{"id":"1","content":"a"}');
      await writeFile(path.join(dir, "test-plan.json"), "{}");
      const hash = async () => (await computeHashes(path.join(dir, "none"), dir, path.join(dir, "none"))).tasks;
      const before = await hash();
      await writeFile(path.join(dir, "test-plan.json"), '{"cases":[]}');
      expect(await hash()).toBe(before);
      await writeFile(path.join(dir, "1.json"), '{"id":"1","content":"b"}');
      expect(await hash()).not.toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("review state", () => {
  it("parses an old review state without the human review fields", () => {
    const old = { phase: "done", round: 1, validationRounds: 0, reports: {} };
    expect(reviewStateSchema.parse(old)).toMatchObject({ humanRound: 0, budgetBase: 0 });
  });

  it("accepts the human step", () => {
    expect(reviewStateSchema.parse({ ...initialReviewState(), phase: "human", humanRound: 1 }).phase).toBe("human");
  });
});

describe("acquireLock", () => {
  const lockFile = () => path.join(dir, LOCK_FILE);

  it("refuses a second acquisition in the same process until released", async () => {
    const release = await acquireLock(dir);
    const before = await readFile(lockFile(), "utf8");
    await expect(acquireLock(dir)).rejects.toBeInstanceOf(LockError);
    await expect(acquireLock(`${dir}/`)).rejects.toThrow("already locked by this process");
    expect(await readFile(lockFile(), "utf8")).toBe(before);
    await release();
    expect(existsSync(lockFile())).toBe(false);
    const again = await acquireLock(dir);
    await again();
  });

  it("lets only one of two concurrent acquisitions win", async () => {
    const results = await Promise.allSettled([acquireLock(dir), acquireLock(dir)]);
    const won = results.filter((r): r is PromiseFulfilledResult<() => Promise<void>> => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(LockError);
    expect(existsSync(lockFile())).toBe(true);
    await won[0]!.value();
    expect(existsSync(lockFile())).toBe(false);
  });

  it("an old release never removes a newer holder's lock", async () => {
    const r1 = await acquireLock(dir);
    await r1();
    const r2 = await acquireLock(dir);
    await r1();
    expect(existsSync(lockFile())).toBe(true);
    await r2();
    expect(existsSync(lockFile())).toBe(false);
  });

  it("release leaves a lock file it no longer owns", async () => {
    const release = await acquireLock(dir);
    await writeFile(lockFile(), `${process.pid}\nsomeone-else\n`);
    await release();
    expect(await readFile(lockFile(), "utf8")).toBe(`${process.pid}\nsomeone-else\n`);
  });

  it("takes over a lock left by a dead process or by an earlier process with this PID", async () => {
    const dead = await execa("node", ["-e", "process.stdout.write(String(process.pid))"]);
    await writeFile(lockFile(), `${dead.stdout}\n`);
    const release = await acquireLock(dir);
    expect((await readFile(lockFile(), "utf8")).split("\n")[0]).toBe(String(process.pid));
    await release();
    await writeFile(lockFile(), `${process.pid}\n`);
    const again = await acquireLock(dir);
    expect((await readFile(lockFile(), "utf8")).split("\n")[1]).not.toBe("");
    await again();
    expect(existsSync(lockFile())).toBe(false);
  });

  it("refuses a lock held by another live process, in old and new format", async () => {
    for (const content of [`${process.ppid}\n`, `${process.ppid}\nabc\n`]) {
      await writeFile(lockFile(), content);
      const attempt = acquireLock(dir);
      await expect(attempt).rejects.toBeInstanceOf(LockError);
      await expect(acquireLock(dir)).rejects.toThrow(`is locked by the running process ${process.ppid}`);
      expect(await lockHolder(dir)).toBe(process.ppid);
      expect(await readFile(lockFile(), "utf8")).toBe(content);
    }
    expect(await readLock(dir)).toEqual({ pid: process.ppid, token: "abc", host: os.hostname(), foreign: false });
  });

  it("writes the host name as the third line", async () => {
    const release = await acquireLock(dir);
    const lines = (await readFile(lockFile(), "utf8")).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(String(process.pid));
    expect(lines[2]).toBe(os.hostname());
    expect(lines[3]).toBe("");
    await release();
  });

  it("adds the sandbox mark as the fourth line in a graph-manager sandbox (F2)", async () => {
    process.env.GRAPH_EXECUTION_SANDBOX = "1";
    try {
      const release = await acquireLock(dir);
      expect((await readFile(lockFile(), "utf8")).split("\n").slice(2)).toEqual([os.hostname(), "sandbox", ""]);
      await release();
    } finally {
      delete process.env.GRAPH_EXECUTION_SANDBOX;
    }
  });

  it("never treats an unmarked lock of another host as stale (KAN-88)", async () => {
    const content = "999999\nabc\nother-host\n";
    await writeFile(lockFile(), content);
    expect(await readLock(dir)).toEqual({ pid: 999999, token: "abc", host: "other-host", foreign: true });
    expect(await lockHolder(dir)).toBe(999999);
    await expect(acquireLock(dir)).rejects.toThrow("locked by process 999999 on host other-host");
    expect(await readFile(lockFile(), "utf8")).toBe(content);
    process.env.GRAPH_EXECUTION_TAKE_LOCK_FROM = "other-host";
    try {
      expect(await lockHolder(dir)).toBeUndefined();
      const release = await acquireLock(dir);
      expect((await readFile(lockFile(), "utf8")).split("\n")[0]).toBe(String(process.pid));
      await release();
    } finally {
      delete process.env.GRAPH_EXECUTION_TAKE_LOCK_FROM;
    }
  });

  describe("a sandbox lock of another host", () => {
    const TAKE = "GRAPH_EXECUTION_TAKE_LOCK_FROM";
    const content = "999999\nabc\nother-host\nsandbox\n";
    afterEach(() => {
      delete process.env[TAKE];
    });

    it("is never stale, even with a pid that is dead here", async () => {
      await writeFile(lockFile(), content);
      await expect(acquireLock(dir)).rejects.toBeInstanceOf(LockError);
      await expect(acquireLock(dir)).rejects.toThrow("locked by process 999999 on host other-host");
      expect(await readFile(lockFile(), "utf8")).toBe(content);
      expect(await lockHolder(dir)).toBe(999999);
      expect(await readLock(dir)).toEqual({ pid: 999999, token: "abc", host: "other-host", foreign: true });
    });

    it("is still refused when GRAPH_EXECUTION_TAKE_LOCK_FROM names another host or is empty", async () => {
      await writeFile(lockFile(), content);
      for (const value of ["someone-else", ""]) {
        process.env[TAKE] = value;
        await expect(acquireLock(dir)).rejects.toThrow("on host other-host");
        expect(await lockHolder(dir)).toBe(999999);
        expect(await readFile(lockFile(), "utf8")).toBe(content);
      }
    });

    it("is taken over when GRAPH_EXECUTION_TAKE_LOCK_FROM names its host", async () => {
      await writeFile(lockFile(), content);
      process.env[TAKE] = "other-host";
      expect(await lockHolder(dir)).toBeUndefined();
      const release = await acquireLock(dir);
      const lines = (await readFile(lockFile(), "utf8")).split("\n");
      expect(lines[0]).toBe(String(process.pid));
      expect(lines[2]).toBe(os.hostname());
      await release();
      expect(existsSync(lockFile())).toBe(false);
    });
  });
});

describe("readLock", () => {
  it("returns undefined for a missing or malformed lock", async () => {
    expect(await readLock(dir)).toBeUndefined();
    await writeFile(path.join(dir, LOCK_FILE), "abc\n");
    expect(await readLock(dir)).toBeUndefined();
  });

  it("reads an old one-line lock as this host's", async () => {
    await writeFile(path.join(dir, LOCK_FILE), "42\n");
    expect(await readLock(dir)).toEqual({ pid: 42, host: os.hostname(), foreign: false });
  });
});
