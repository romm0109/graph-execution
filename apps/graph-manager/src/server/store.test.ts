import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { BUILTIN_REVIEWERS } from "graph-execution/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DB_FILE, type Db } from "./db/db.js";
import { SqliteDb } from "./db/sqlite.js";
import { ADMIN_USER, type User } from "./identity.js";
import { DEFAULT_RECIPE } from "./sandbox-image.js";
import { parseUserData, projectOf, projectsOf, SqlStore } from "./store.js";
import { tempDir } from "./test-helpers.js";

const U2: User = { id: "u2", name: "u2" };

let dir: string;
let cleanup: () => Promise<void>;
const open: Db[] = [];

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  await mkdir(dir, { recursive: true });
});
afterEach(async () => {
  // Windows cannot remove an open SQLite file.
  for (const db of open.splice(0)) await db.close();
  await cleanup();
});

const file = (): string => path.join(dir, DB_FILE);

/** A new connection to the temp db file and a store on it (a "reopen"). */
async function reopen(): Promise<SqlStore> {
  const db = await SqliteDb.open(file());
  open.push(db);
  return SqlStore.open(db);
}

/** Writes a raw `user_data` row, as a store from before a change of the schema would have. */
async function rawRow(userId: string, data: unknown): Promise<void> {
  const store = await reopen();
  await store.db.exec("INSERT INTO user_data (user_id, data, updated_at) VALUES (?, ?, ?)", [userId, JSON.stringify(data), "2026-01-01"]);
}

describe("SqlStore on SQLite", () => {
  it("creates the db file with mode 600 and an instance secret kept across opens", async () => {
    const store = await reopen();
    const { sessionSecret, instanceId } = store.instance();
    expect(sessionSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(instanceId).toMatch(/^[0-9a-f]{16}$/);
    if (process.platform !== "win32") expect((await stat(file())).mode & 0o777).toBe(0o600);
    const again = await reopen();
    expect(again.instance()).toEqual({ sessionSecret, instanceId });
  });

  it("gives a new user the defaults and the built-in reviewers", async () => {
    const admin = await (await reopen()).forUser(ADMIN_USER);
    expect(admin.get().forges).toEqual({});
    expect(admin.get().prs).toEqual({});
    expect(admin.reviewers()).toEqual(BUILTIN_REVIEWERS);
    expect((await (await reopen()).forUser(ADMIN_USER)).reviewers()).toEqual(BUILTIN_REVIEWERS);
  });

  it("seeds the built-in reviewers into a stored row without them and writes it", async () => {
    await rawRow("admin", {});
    const admin = await (await reopen()).forUser(ADMIN_USER);
    expect(admin.reviewers()).toEqual(BUILTIN_REVIEWERS);
    const rows = await (await reopen()).db.query<{ data: string }>("SELECT data FROM user_data WHERE user_id = ?", ["admin"]);
    expect((JSON.parse(rows[0]!.data) as { reviewers?: unknown }).reviewers).toEqual(BUILTIN_REVIEWERS);
  });

  it("migrates a stored sandbox recipe in the old { base, packages, extraLines } shape", async () => {
    await rawRow("admin", { sandboxRecipe: { base: "node:22", packages: ["jq", "curl"], extraLines: "RUN true" } });
    const r = (await (await reopen()).forUser(ADMIN_USER)).get().sandboxRecipe;
    expect(r?.base).toBe("node:22");
    expect(r?.toolchains).toEqual(DEFAULT_RECIPE.toolchains);
    expect(r?.extraLines).toBe("RUN apt-get update && apt-get install -y --no-install-recommends curl jq && rm -rf /var/lib/apt/lists/*\nRUN true");
  });

  it("persists concurrent updates", async () => {
    const admin = await (await reopen()).forUser(ADMIN_USER);
    await Promise.all([
      admin.update((d) => {
        d.forges.github = { token: "t", login: "octo" };
      }),
      admin.update((d) => {
        d.prs["ws/run"] = { url: "u", number: 1, branch: "b", forge: "github", createdAt: "2026-01-01" };
      }),
    ]);
    const again = await (await reopen()).forUser(ADMIN_USER);
    expect(again.get().forges.github).toEqual({ token: "t", login: "octo" });
    expect(again.get().prs["ws/run"]?.number).toBe(1);
  });

  it("rejects an update that breaks the schema and keeps the old data", async () => {
    const admin = await (await reopen()).forUser(ADMIN_USER);
    await expect(
      admin.update((d) => {
        (d as { forges: unknown }).forges = 5;
      }),
    ).rejects.toThrow();
    expect(admin.get().forges).toEqual({});
    await admin.update((d) => {
      d.forges.github = { token: "t", login: "l" };
    });
    expect(admin.get().forges.github?.login).toBe("l");
    expect((await (await reopen()).forUser(ADMIN_USER)).get().forges.github?.login).toBe("l");
  });

  it("opens a stored row without the sandbox keys with their defaults", async () => {
    await rawRow("admin", { forges: {}, prs: {}, revokedSessions: {} });
    const admin = await (await reopen()).forUser(ADMIN_USER);
    expect(admin.get().sandboxes).toEqual({});
    expect(admin.get().sandboxLimits).toEqual({ cpus: 2, memoryMb: 4096, pids: 2048 });
    expect(admin.get().workspaceSettings).toEqual({});
    expect(projectsOf(admin.get())).toEqual([]);
    await admin.update((d) => {
      d.sandboxes["ws/run"] = { runId: "run", workspace: "ws", container: "c", name: "n", host: "h", image: "i", port: 7600, startedAt: "2026-01-01" };
      d.workspaceSettings.ws = { image: "img", sandbox: true };
    });
    const again = await (await reopen()).forUser(ADMIN_USER);
    expect(again.get().sandboxes["ws/run"]?.host).toBe("h");
    expect(again.get().workspaceSettings.ws).toEqual({ image: "img", sandbox: true });
  });

  it("throws on an invalid row, and retries on the next call", async () => {
    await rawRow("admin", { forges: 5 });
    const store = await reopen();
    await expect(store.forUser(ADMIN_USER)).rejects.toThrow(/^user data of admin is invalid: forges: /);
    await store.db.exec("UPDATE user_data SET data = ? WHERE user_id = ?", ["{}", "admin"]);
    expect((await store.forUser(ADMIN_USER)).get().forges).toEqual({});
  });

  it("keeps two users' data apart, also after a reopen", async () => {
    const store = await reopen();
    const admin = await store.forUser(ADMIN_USER);
    const u2 = await store.forUser(U2);
    await admin.update((d) => {
      d.forges.github = { token: "admin-token", login: "admin" };
      d.revokedSessions.n1 = 1;
    });
    await u2.update((d) => {
      d.projects.p = { name: "p", workspaces: [], createdAt: "2026-01-01" };
    });
    expect(u2.get().forges).toEqual({});
    expect(u2.get().revokedSessions).toEqual({});
    expect(admin.get().projects).toEqual({});
    const again = await reopen();
    expect((await again.forUser(U2)).get().forges).toEqual({});
    expect(Object.keys((await again.forUser(U2)).get().projects)).toEqual(["p"]);
    expect((await again.forUser(ADMIN_USER)).get().forges.github?.login).toBe("admin");
    expect((await again.forUser(ADMIN_USER)).get().projects).toEqual({});
  });
});

describe("projects stored with workspace ids", () => {
  it("read as their repositories, with the derived workspace ids", () => {
    const d = parseUserData(
      {
        projects: {
          billing: { name: "billing", workspaces: ["github~octo~api", "github~octo~web"], createdAt: "2026-01-01T00:00:00.000Z" },
          lib: { name: "lib", workspaces: ["gitlab~grp~sub~proj", "gitlab~grp~x", "bad", "svn~a~b"], createdAt: "2026-01-01T00:00:00.000Z" },
        },
      },
      "test",
    );
    expect(d.projects.billing).toEqual({
      name: "billing",
      repos: [
        { forge: "github", owner: "octo", name: "api" },
        { forge: "github", owner: "octo", name: "web" },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(projectOf(d, "billing")?.workspaces).toEqual(["github~octo~api", "github~octo~web"]);
    expect(d.projects.lib?.repos).toEqual([
      { forge: "gitlab", owner: "grp/sub", name: "proj" },
      { forge: "gitlab", owner: "grp", name: "x" },
    ]);
    expect(projectOf(d, "lib")?.workspaces).toEqual(["gitlab~grp~sub~proj", "gitlab~grp~x"]);
    // A record already in the new shape stays as it is.
    expect(parseUserData({ projects: { billing: d.projects.billing } }, "test").projects.billing).toEqual(d.projects.billing);
  });
});
