// The import of graph-manager.json (the store before the database) into the user admin.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE } from "../auth.js";
import { ADMIN_USER } from "../identity.js";
import { migrateRecipe, recipeSchema } from "../sandbox-image.js";
import { DATA_FILE, migrateProject, SqlStore } from "../store.js";
import { tempDir, testConfig } from "../test-helpers.js";
import { DB_FILE, type Db } from "./db.js";
import { SqliteDb } from "./sqlite.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/graph-manager.json", import.meta.url));

let dir: string;
let dataDir: string;
let cleanup: () => Promise<void>;
const dbs: Db[] = [];

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  dataDir = path.join(dir, "data");
  await mkdir(dataDir, { recursive: true });
});
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.close();
  await cleanup();
});

async function openStore(): Promise<SqlStore> {
  const db = await SqliteDb.open(path.join(dataDir, DB_FILE));
  dbs.push(db);
  return SqlStore.open(db, { dataDir });
}

const fixture = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(FIXTURE, "utf8")) as Record<string, unknown>;

describe("importing graph-manager.json", () => {
  it("moves every setting into admin and the secret and instance id into instance, then renames the file", async () => {
    await copyFile(FIXTURE, path.join(dataDir, DATA_FILE));
    const store = await openStore();
    expect(existsSync(path.join(dataDir, DATA_FILE))).toBe(false);
    expect(await readFile(path.join(dataDir, `${DATA_FILE}.imported`))).toEqual(await readFile(FIXTURE));

    const f = await fixture();
    expect(store.instance()).toEqual({ sessionSecret: f.sessionSecret, instanceId: f.instanceId });
    const rest = { ...f };
    delete rest.sessionSecret;
    delete rest.instanceId;
    const admin = await store.forUser(ADMIN_USER);
    const projects = Object.fromEntries(Object.entries(rest.projects as Record<string, object>).map(([k, v]) => [k, migrateProject(v)]));
    expect(admin.get()).toEqual({ ...rest, projects, sandboxRecipe: recipeSchema.parse(migrateRecipe(f.sandboxRecipe)), sessions: {}, ownedWorkspaces: [], notices: [], agentKeys: {}, agentLogins: {}, hostedRuns: {} });
    expect(admin.get().sandboxRecipe?.extraLines).toMatch(/^RUN apt-get update .* curl jq .*\nRUN true$/);
    expect(admin.reviewers().map((r) => [r.id, r.enabled])).toEqual([
      ["code", false],
      ["security", true],
    ]);
    expect(admin.get().prs["billing/suite-20260102-090000-ef01/api"]?.linked).toBe(true);
    expect(admin.get().forges.gitlab?.baseUrl).toBe("https://gitlab.example.com");

    // It survives a reopen, and another user starts empty.
    const again = await openStore();
    expect(again.instance()).toEqual(store.instance());
    expect((await again.forUser(ADMIN_USER)).get()).toEqual(admin.get());
    expect((await again.forUser({ id: "u2", name: "u2" })).get().forges).toEqual({});
  });

  it("imports only once: a later graph-manager.json stays where it is", async () => {
    await copyFile(FIXTURE, path.join(dataDir, DATA_FILE));
    const first = await openStore();
    await writeFile(path.join(dataDir, DATA_FILE), JSON.stringify({ sessionSecret: "other", forges: {} }));
    const second = await openStore();
    expect(existsSync(path.join(dataDir, DATA_FILE))).toBe(true);
    expect(second.instance()).toEqual(first.instance());
    expect((await second.forUser(ADMIN_USER)).get().forges.github?.login).toBe("octo");
  });

  it("does not import over an admin that already has data", async () => {
    const fresh = await openStore();
    const secret = fresh.instance().sessionSecret;
    await (await fresh.forUser(ADMIN_USER)).update((d) => {
      d.forges.github = { token: "t", login: "kept" };
    });
    await copyFile(FIXTURE, path.join(dataDir, DATA_FILE));
    const again = await openStore();
    expect(existsSync(path.join(dataDir, DATA_FILE))).toBe(true);
    expect(again.instance().sessionSecret).toBe(secret);
    expect((await again.forUser(ADMIN_USER)).get().forges.github?.login).toBe("kept");
  });

  it("fails on a broken file and imports nothing", async () => {
    await writeFile(path.join(dataDir, DATA_FILE), "{not json");
    await expect(openStore()).rejects.toThrow(/not valid JSON/);
    expect(existsSync(path.join(dataDir, DATA_FILE))).toBe(true);
    const rows = await dbs[0]!.query("SELECT user_id FROM user_data");
    expect(rows).toEqual([]);

    await writeFile(path.join(dataDir, DATA_FILE), JSON.stringify({ forges: {} }));
    await expect(openStore()).rejects.toThrow(/graph-manager\.json is invalid: sessionSecret/);
  });

  it("keeps old session cookies valid", async () => {
    await copyFile(FIXTURE, path.join(dataDir, DATA_FILE));
    const config = testConfig(dir);
    const app = await buildApp(config, { webDir: path.join(dir, "no-web"), viewCache: false });
    try {
      const f = await fixture();
      const cookie = `${SESSION_COOKIE}=${signSession(f.sessionSecret as string, "admin")}`;
      expect((await app.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(200);
      const forges = await app.inject({ url: "/api/forges", headers: { cookie } });
      expect(forges.json<{ github: { login: string } }>().github.login).toBe("octo");
      expect((await app.inject({ url: "/api/auth/me", headers: { cookie: `${SESSION_COOKIE}=${signSession("f".repeat(64), "admin")}` } })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
    expect(existsSync(path.join(config.dataDir, DB_FILE))).toBe(true);
  });
});
