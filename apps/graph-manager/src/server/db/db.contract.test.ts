// The Db and SqlStore contract, run on SQLite always and on Postgres when GM_TEST_DATABASE_URL is set (CI's postgres job).
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../config.js";
import { ADMIN_USER, type User } from "../identity.js";
import { Readable } from "node:stream";
import { FolderBlobStore } from "../blobs.js";
import { SqlRunArchive } from "../runarchive.js";
import type { RunSummary } from "../runs.js";
import { SqlStore } from "../store.js";
import { gzipTar } from "../tar.js";
import { tempDir } from "../test-helpers.js";
import { openDb, type Db } from "./db.js";
import { listMigrations, migrate } from "./migrate.js";
import { PostgresDb, toPgParams } from "./postgres.js";
import { SqliteDb } from "./sqlite.js";

const U2: User = { id: "u2", name: "u2" };

/** The cases every Db driver must pass. `open` gives a fresh, empty database. */
export function dbContract(name: string, open: () => Promise<{ db: Db; cleanup(): Promise<void> }>): void {
  describe(`Db contract (${name})`, () => {
    let db: Db;
    let cleanup: () => Promise<void>;
    beforeEach(async () => {
      ({ db, cleanup } = await open());
    });
    afterEach(async () => {
      await cleanup();
    });

    it("migrates once: a second run applies nothing", async () => {
      expect(await migrate(db)).toContain(1);
      expect(await migrate(db)).toEqual([]);
      const rows = await db.query<{ version: number | string }>("SELECT version FROM schema_version");
      expect(rows.map((r) => Number(r.version))).toContain(1);
    });

    it("round-trips text and integers through ? params", async () => {
      await migrate(db);
      await db.exec("INSERT INTO instance (key, value) VALUES (?, ?)", ["k", "v ? with a question"]);
      await db.exec("INSERT INTO schema_version (version) VALUES (?)", [990]);
      expect(await db.query("SELECT key, value FROM instance WHERE key = ?", ["k"])).toEqual([{ key: "k", value: "v ? with a question" }]);
      const rows = await db.query<{ version: number }>("SELECT version FROM schema_version WHERE version = ?", [990]);
      expect(rows).toEqual([{ version: 990 }]);
      expect(typeof rows[0]?.version).toBe("number");
    });

    it("commits a transaction, and rolls back and rethrows a failing one", async () => {
      await migrate(db);
      const got = await db.transaction(async (tx) => {
        await tx.exec("INSERT INTO instance (key, value) VALUES (?, ?)", ["a", "1"]);
        return 42;
      });
      expect(got).toBe(42);
      await expect(
        db.transaction(async (tx) => {
          await tx.exec("INSERT INTO instance (key, value) VALUES (?, ?)", ["b", "2"]);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      const keys = (await db.query<{ key: string }>("SELECT key FROM instance WHERE key IN (?, ?) ORDER BY key", ["a", "b"])).map((r) => r.key);
      expect(keys).toEqual(["a"]);
    });

    it("SqlStore: keeps users apart, caches them, persists and serializes updates", async () => {
      const store = await SqlStore.open(db);
      const inst = store.instance();
      expect(inst.sessionSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(inst.instanceId).toMatch(/^[0-9a-f]{16}$/);
      const admin = await store.forUser(ADMIN_USER);
      expect(await store.forUser(ADMIN_USER)).toBe(admin);
      const u2 = await store.forUser(U2);
      await Promise.all([
        admin.update((d) => {
          d.forges.github = { token: "t", login: "octo" };
        }),
        admin.update((d) => {
          d.prs["ws/run"] = { url: "u", number: 1, branch: "b", forge: "github", createdAt: "2026-01-01" };
        }),
        u2.update((d) => {
          d.runDefaults.ws = { provider: "fake", tasksDir: "t", spec: "s", options: {} };
        }),
      ]);
      expect(u2.get().forges).toEqual({});
      expect(admin.get().runDefaults).toEqual({});

      const again = await SqlStore.open(db);
      expect(again.instance()).toEqual(inst);
      const admin2 = await again.forUser(ADMIN_USER);
      expect(admin2).not.toBe(admin);
      expect(admin2.get().forges.github).toEqual({ token: "t", login: "octo" });
      expect(admin2.get().prs["ws/run"]?.number).toBe(1);
      expect(admin2.get().runDefaults).toEqual({});
      expect((await again.forUser(U2)).get().runDefaults.ws?.provider).toBe("fake");
      expect((await again.forUser(U2)).get().forges).toEqual({});
    });

    describe("SqlRunArchive", () => {
      let blobDir: { dir: string; cleanup(): Promise<void> };
      let archive: SqlRunArchive;
      beforeEach(async () => {
        await migrate(db);
        blobDir = await tempDir();
        archive = new SqlRunArchive(db, new FolderBlobStore(path.join(blobDir.dir, "blobs")));
      });
      afterEach(async () => {
        await blobDir.cleanup();
      });
      const summary = (id: string, createdAt: string, status = "applied"): RunSummary => ({ workspaceId: "ws", type: "run", id, status, kind: "done", live: true, viewUrl: "/x", createdAt });

      it("records rows, lists them newest first per user, and upserts", async () => {
        await archive.record(ADMIN_USER, "ws", "r1", { status: "applied", startedAt: "2026-01-01", summary: summary("r1", "2026-01-01") });
        await archive.record(ADMIN_USER, "ws", "r2", { status: "running", startedAt: "2026-01-02", summary: summary("r2", "2026-01-02", "running") });
        await archive.record(U2, "ws2", "r9", { status: "failed", startedAt: "2026-01-03", summary: { ...summary("r9", "2026-01-03"), workspaceId: "ws2" } });
        let list = await archive.list(ADMIN_USER);
        expect(list.map((r) => r.id)).toEqual(["r2", "r1"]);
        expect(list[0]).toMatchObject({ archived: true, live: false, status: "running" });
        expect(list[0]?.viewUrl).toBeUndefined();
        expect((await archive.list(U2)).map((r) => r.id)).toEqual(["r9"]);
        expect(await archive.list(U2, { workspaceId: "ws" })).toEqual([]);
        await archive.record(ADMIN_USER, "ws", "r2", { status: "applied", startedAt: "2026-01-02", endedAt: "2026-01-02T01:00:00Z", summary: summary("r2", "2026-01-02") });
        list = await archive.list(ADMIN_USER);
        expect(list).toHaveLength(2);
        expect(list[0]?.status).toBe("applied");
        const rows = await db.query<{ status: string; ended_at: string }>("SELECT status, ended_at FROM runs WHERE user_id = ? AND run_id = ?", ["admin", "r2"]);
        expect(rows).toEqual([{ status: "applied", ended_at: "2026-01-02T01:00:00Z" }]);
      });

      it("saves a folder and gets its files, keeps the blob across a later record, and deletes a user", async () => {
        await archive.saveFolder(ADMIN_USER, "ws", "r1", Readable.from([gzipTar([{ path: "run.log", content: Buffer.from("a\nb\n") }, { path: "logs/t.log", content: Buffer.from("t") }], { uid: 0, gid: 0 })]));
        expect((await archive.get(ADMIN_USER, "ws", "r1"))?.summary.status).toBe("unknown");
        await archive.record(ADMIN_USER, "ws", "r1", { status: "failed", summary: summary("r1", "2026-01-01", "failed") });
        const got = await archive.get(ADMIN_USER, "ws", "r1");
        expect(got).toMatchObject({ archived: true, files: ["logs/t.log", "run.log"], logTail: "a\nb", summary: { status: "failed", archived: true } });
        expect(await archive.get(U2, "ws", "r1")).toBeUndefined();
        await archive.deleteUser("admin");
        expect(await archive.list(ADMIN_USER)).toEqual([]);
        expect(await archive.get(ADMIN_USER, "ws", "r1")).toBeUndefined();
      });
    });
  });
}

dbContract("sqlite", async () => {
  const t = await tempDir();
  const db = await SqliteDb.open(path.join(t.dir, "graph-manager.db"));
  return {
    db,
    cleanup: async () => {
      await db.close();
      await t.cleanup();
    },
  };
});

const pgUrl = process.env.GM_TEST_DATABASE_URL;
(pgUrl ? describe : describe.skip)("postgres", () =>
  dbContract("postgres", async () => {
    const schema = `gm_test_${randomBytes(6).toString("hex")}`;
    const db = await PostgresDb.connect(pgUrl!, { schema });
    return {
      db,
      cleanup: async () => {
        await db.exec(`DROP SCHEMA "${schema}" CASCADE`);
        await db.close();
      },
    };
  }),
);

describe("migrations", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "gm-migrations-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("apply a missing lower version after a higher one, and pick the dialect's file", async () => {
    await writeFile(path.join(dir, "001-base.sql"), "CREATE TABLE a (x TEXT);");
    await writeFile(path.join(dir, "003-c.sql"), "CREATE TABLE c (x TEXT);");
    await writeFile(path.join(dir, "notes.txt"), "not a migration");
    const db = await SqliteDb.open(":memory:");
    try {
      expect(await migrate(db, dir)).toEqual([1, 3]);
      await writeFile(path.join(dir, "002-b.sqlite.sql"), "CREATE TABLE b (x TEXT);");
      await writeFile(path.join(dir, "002-b.postgres.sql"), "THIS IS NOT SQLITE;");
      expect(await migrate(db, dir)).toEqual([2]);
      expect(await migrate(db, dir)).toEqual([]);
      expect(await db.query("SELECT x FROM b")).toEqual([]);
      const versions = (await db.query<{ version: number }>("SELECT version FROM schema_version ORDER BY version")).map((r) => r.version);
      expect(versions).toEqual([1, 2, 3]);
    } finally {
      await db.close();
    }
  });

  it("roll back every migration of the run when one fails", async () => {
    await writeFile(path.join(dir, "001-a.sql"), "CREATE TABLE a (x TEXT);");
    await writeFile(path.join(dir, "002-bad.sql"), "CREATE TABLE nope (;");
    const db = await SqliteDb.open(":memory:");
    try {
      await expect(migrate(db, dir)).rejects.toThrow();
      expect(await db.query("SELECT name FROM sqlite_master WHERE name = ?", ["a"])).toEqual([]);
      expect(await db.query("SELECT version FROM schema_version")).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("reject two files with the same number and dialect", async () => {
    await writeFile(path.join(dir, "004-a.sql"), "");
    await writeFile(path.join(dir, "004-b.sql"), "");
    await expect(listMigrations("sqlite", dir)).rejects.toThrow("duplicate migration 004");
    expect(await listMigrations("postgres", dir).catch((e: Error) => e.message)).toBe("duplicate migration 004");
  });

  it("ship 001-base.sql for both dialects", async () => {
    for (const dialect of ["sqlite", "postgres"] as const) expect((await listMigrations(dialect))[0]?.version).toBe(1);
  });
});

describe("toPgParams", () => {
  it("numbers the ? placeholders", () => {
    expect(toPgParams("a = ? and b = ?")).toBe("a = $1 and b = $2");
    expect(toPgParams("select 1")).toBe("select 1");
  });
});

describe("openDb", () => {
  it("fails with a ConfigError on an unreachable Postgres", async () => {
    const err = await openDb({ dataDir: os.tmpdir(), databaseUrl: "postgres://127.0.0.1:1/x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/^Cannot connect to the database: /);
  });

  it("opens SQLite in the data dir without a URL, and stores booleans as 0/1", async () => {
    const t = await tempDir();
    const db = await openDb({ dataDir: path.join(t.dir, "data") });
    try {
      expect(db.dialect).toBe("sqlite");
      await migrate(db);
      await db.exec("INSERT INTO instance (key, value) VALUES (?, ?)", ["flag", true]);
      expect(await db.query("SELECT value FROM instance WHERE key = ?", ["flag"])).toEqual([{ value: "1" }]);
    } finally {
      await db.close();
      await t.cleanup();
    }
  });
});
