import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "./app.js";
import type { Config } from "./config.js";
import { DB_FILE, type Db } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { SqliteDb } from "./db/sqlite.js";
import { repoRefOf, type RepoRef } from "./host/types.js";
import { ADMIN_USER } from "./identity.js";
import { createProjectFolder } from "./projects.js";
import { resolveWorkspace } from "./workspaces.js";
import { SqlStore, type UserStore } from "./store.js";

/** A temp dir that `cleanup` removes. */
export async function tempDir(prefix = "gm-test-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  // Windows releases an exited run's handles on its folders a moment later (EBUSY): retry, as the engine's tests do.
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

/** A config pointing at temp dirs under `dir`. */
export function testConfig(dir: string, overrides: Partial<Config> = {}): Config {
  return {
    password: "pw",
    port: 0,
    host: "127.0.0.1",
    dataDir: path.join(dir, "data"),
    workspacesDir: path.join(dir, "ws"),
    githubApiUrl: "https://api.github.com",
    graphExecutionBin: "graph-execution",
    auth: "users",
    signup: "closed",
    ...overrides,
  };
}

/** The `name=value` part of a response's first Set-Cookie header. */
export function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? String(raw[0]) : String(raw);
  return header.split(";")[0] ?? "";
}

/** A store on a SQLite file at `<dataDir>/graph-manager.db`; `close` closes the db (do it before removing the dir). */
export async function openTestStore(dataDir: string): Promise<{ db: Db; store: SqlStore; admin: UserStore; close(): Promise<void> }> {
  await mkdir(dataDir, { recursive: true });
  const db = await SqliteDb.open(path.join(dataDir, DB_FILE));
  try {
    const store = await SqlStore.open(db);
    const admin = await store.forUser(ADMIN_USER);
    return { db, store, admin, close: () => db.close() };
  } catch (err) {
    await db.close();
    throw err;
  }
}

/** A private in-memory SQLite, already migrated. */
export async function memoryDb(): Promise<Db> {
  const db = await SqliteDb.open(":memory:");
  await migrate(db);
  return db;
}

/** A store on `db` (default: a new `memoryDb()`) and the admin's UserStore. */
export async function testStore(db?: Db): Promise<{ db: Db; store: SqlStore; admin: UserStore }> {
  const d = db ?? (await memoryDb());
  const store = await SqlStore.open(d);
  return { db: d, store, admin: await store.forUser(ADMIN_USER) };
}

/** An app on temp dirs and an in-memory SQLite, already logged in: pass `cookie` in `headers`. */
export async function appWithLogin(overrides: Partial<Config> = {}, buildOpts: Partial<BuildAppOptions> = {}): Promise<{
  app: FastifyInstance;
  cookie: string;
  config: Config;
  /** The admin's store: every request of the test acts for the admin. */
  store: UserStore;
  stores: SqlStore;
  db: Db;
  cleanup: () => Promise<void>;
}> {
  const { dir, cleanup: rmDir } = await tempDir();
  const config = testConfig(dir, overrides);
  const { db, store: stores, admin } = await testStore();
  const app = await buildApp(config, { store: stores, db, webDir: path.join(dir, "no-web"), viewCache: false, archiver: false, ...buildOpts });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: config.password } });
  if (res.statusCode !== 204) throw new Error(`login failed: ${res.statusCode}`);
  return {
    app,
    cookie: cookieOf(res),
    config,
    store: admin,
    stores,
    db,
    cleanup: async () => {
      await app.close();
      await db.close();
      await rmDir();
    },
  };
}

/** Logs in as `username` and returns the session cookie (`name=value`); throws unless the login answers 204. */
export async function loginAs(app: FastifyInstance, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  if (res.statusCode !== 204) throw new Error(`login as ${username} failed: ${res.statusCode} ${res.body}`);
  return cookieOf(res);
}

/** Signs up (needs `signup: "open"`) and returns the session cookie; throws unless it answers 204. */
export async function signUp(app: FastifyInstance, username: string, password: string, displayName = username): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { username, password, displayName } });
  if (res.statusCode !== 204) throw new Error(`sign-up of ${username} failed: ${res.statusCode} ${res.body}`);
  return cookieOf(res);
}

/**
 * Clones a fake-forge repository the way a session leaves it (`git clone`, `.graph-execution/` excluded) into
 * `<workspacesDir>/<forge>/<fullPath>`, for tests that need a clone without opening a session. Returns its path.
 */
export async function cloneForTest(config: Config, forgeDir: string, kind: "github" | "gitlab", fullPath: string): Promise<string> {
  const { execa } = await import("execa");
  const { appendFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const dest = path.join(config.workspacesDir, kind, ...fullPath.split("/"));
  await mkdir(path.dirname(dest), { recursive: true });
  await execa("git", ["clone", "-q", "--", pathToFileURL(path.join(forgeDir, `${fullPath}.git`)).href, dest], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  await mkdir(path.join(dest, ".git", "info"), { recursive: true });
  await appendFile(path.join(dest, ".git", "info", "exclude"), ".graph-execution/\n");
  return dest;
}

/**
 * Writes a project's folder from local clones, as a project session's prepare does (projects are created without a
 * folder): `project.json`, the `repos/` links and its own git repo.
 */
export async function writeProjectFolderForTest(workspacesDir: string, id: string, name: string, workspaceIds: string[]): Promise<void> {
  const workspaces = workspaceIds.map((w) => {
    const ws = resolveWorkspace(workspacesDir, w);
    if (!ws) throw new Error(`no clone ${w}`);
    return ws;
  });
  const repos = workspaceIds.map((w) => repoRefOf(w)!);
  await createProjectFolder(workspacesDir, { id, name, repos, workspaces: workspaceIds, createdAt: "" }, workspaces);
}

/** `github~octo~api` → `{ forge: "github", owner: "octo", name: "api" }`, for request bodies. */
export const repoOfId = (id: string): RepoRef => repoRefOf(id)!;
