import { randomBytes } from "node:crypto";
import { BUILTIN_REVIEWERS, reviewerSchema, type Reviewer } from "graph-execution/api";
import { z } from "zod";
import type { Db } from "./db/db.js";
import { importJsonFile } from "./db/import-json.js";
import { migrate } from "./db/migrate.js";
import type { User } from "./identity.js";
import { repoRefOf, workspaceIdOf } from "./host/types.js";
import type { Project } from "./projects.js";
import { migrateRecipe, recipeSchema } from "./sandbox-image.js";

const forgeSchema = z.enum(["github", "gitlab"]);

export const repoRefSchema = z.object({ forge: forgeSchema, owner: z.string(), name: z.string(), baseUrl: z.string().optional() });

/**
 * A project saved before projects were made of forge repositories (`{ name, workspaces: string[], createdAt }`) as
 * `{ name, repos, createdAt }`: each workspace id read as its repository; ids that do not parse are dropped.
 */
export function migrateProject(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const rec = raw as Record<string, unknown>;
  if (rec.repos !== undefined || !Array.isArray(rec.workspaces)) return raw;
  const { workspaces, ...rest } = rec;
  const repos = (workspaces as unknown[]).flatMap((id) => {
    const ref = typeof id === "string" ? repoRefOf(id) : undefined;
    return ref ? [ref] : [];
  });
  return { ...rest, repos };
}

const projectRecord = z.preprocess(migrateProject, z.object({ name: z.string(), repos: z.array(repoRefSchema), createdAt: z.string() }));
export type ProjectRecord = z.infer<typeof projectRecord>;

/** A repo session (docs/prd/hosted-sessions.md, "Session lifecycle"): a repository with at least one open terminal. */
export const sessionSchema = z.object({
  id: z.string(),
  repo: repoRefSchema,
  workspaceId: z.string(),
  /** A project session (`workspaceId` = `project~<projectId>`): `repo` is its first repository, `repos` all of them. */
  projectId: z.string().optional(),
  repos: z.array(repoRefSchema).optional(),
  branch: z.string(),
  state: z.enum(["starting", "live", "asking", "ending", "save-failed"]),
  startedAt: z.string(),
  error: z.string().optional(),
});

/** A run of a remote session in its own run container (docs/prd/hosted-sessions.md, "Hosted runs"). */
export const hostedRunSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  workspaceId: z.string(),
  /** The session branch: the run starts from its last pushed commit and its PR targets it. */
  branch: z.string(),
  state: z.enum(["starting", "running", "finishing", "done", "failed"]),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  prUrl: z.string().optional(),
  prError: z.string().optional(),
  prTitle: z.string().optional(),
  prBody: z.string().optional(),
  error: z.string().optional(),
  /** A project run: each repository's name in project.json, its forge path and the PR it got (if any). */
  repos: z
    .array(z.object({ name: z.string(), fullPath: z.string(), title: z.string(), body: z.string(), pushed: z.boolean(), prUrl: z.string().optional(), error: z.string().optional() }))
    .optional(),
});

/** One user's settings: a JSON document in `user_data`. */
export const dataSchema = z.object({
  forges: z
    .object({
      github: z.object({ token: z.string(), login: z.string() }).optional(),
      gitlab: z.object({ token: z.string(), login: z.string(), baseUrl: z.string() }).optional(),
    })
    .default({}),
  /**
   * Pull requests opened from runs. Key: `${workspaceId}/${runId}` for a workspace run, `${projectId}/${runId}/${repo}`
   * for one repo of a project run (bare project id, repo = its name in project.json). `linked`: the body of a project
   * PR lists all the project's other PRs.
   */
  prs: z
    .record(
      z.string(),
      z.object({
        url: z.string(),
        number: z.number(),
        branch: z.string(),
        base: z.string().optional(),
        forge: forgeSchema,
        createdAt: z.string(),
        linked: z.boolean().optional(),
      }),
    )
    .default({}),
  /** Session nonces revoked by logout, with the session's expiry (ms) so they can be pruned once it has passed. */
  revokedSessions: z.record(z.string(), z.number()).default({}),
  /** Sessions issued before this time (ms) no longer work: set when the password changes (ends the other sign-ins). */
  sessionsValidAfter: z.number().optional(),
  /** The last Start run choices per workspace id, written when a run starts (docs/prd/run-options.md). */
  runDefaults: z
    .record(
      z.string(),
      z.object({ provider: z.string(), tasksDir: z.string(), spec: z.string(), options: z.record(z.string(), z.unknown()).default({}) }),
    )
    .default({}),
  /** The global reviewers, edited on the Reviewers page; seeded from the engine's built-ins. */
  reviewers: z.array(reviewerSchema).optional(),
  /** Live sandbox containers of runs (KAN-88). Key: `${workspaceId}/${runId}`. Removed once the container is gone. */
  sandboxes: z
    .record(
      z.string(),
      z.object({
        runId: z.string(),
        workspace: z.string(),
        container: z.string(),
        name: z.string(),
        /** The container's hostname: what the engine writes as the lock host. */
        host: z.string(),
        image: z.string(),
        port: z.number().int().default(7600),
        /** The run page's secret (GRAPH_EXECUTION_WEB_TOKEN): the proxy sends it, other sandboxes don't know it. */
        token: z.string().optional(),
        startedAt: z.string(),
      }),
    )
    .default({}),
  /** Resource limits of every sandbox container (Settings → Sandbox). */
  sandboxLimits: z
    .object({
      cpus: z.number().min(0.1).max(256).default(2),
      memoryMb: z.number().int().min(256).max(1048576).default(4096),
      pids: z.number().int().min(64).max(1000000).default(2048),
    })
    .default({ cpus: 2, memoryMb: 4096, pids: 2048 }),
  /**
   * The recipe of the default sandbox image (Settings → Sandbox); absent = the default recipe. A recipe saved in the old
   * `{ base, packages, extraLines }` shape is migrated when it is read (see migrateRecipe).
   */
  sandboxRecipe: z.preprocess(migrateRecipe, recipeSchema).optional(),
  /**
   * Per-workspace settings. The image source: `image` (a ready-made image), `recipe` (the workspace's own recipe, built
   * on save) or neither (the global recipe's image); at most one of the two is set. `sandbox`: the last value of "Run in sandbox".
   */
  workspaceSettings: z
    .record(
      z.string(),
      z.object({
        image: z.string().optional(),
        sandbox: z.boolean().optional(),
        recipe: z.preprocess(migrateRecipe, recipeSchema).optional(),
      }),
    )
    .default({}),
  /**
   * Projects (docs/prd/multi-repo.md): named groups of forge repositories of one forge, cloned when a project session
   * starts. Key: the project id (the name's slug). A project saved with workspace ids is migrated (migrateProject).
   */
  projects: z.record(z.string(), projectRecord).default({}),
  /** The user's repo sessions. Key: the session id. */
  sessions: z.record(z.string(), sessionSchema).default({}),
  /** Workspace ids this user has opened a session on (kept after the session ends, so its runs stay visible). */
  ownedWorkspaces: z.array(z.string()).default([]),
  /** Messages for the user, shown once by the web UI's banner (`GET /api/notices` returns and clears them). */
  notices: z.array(z.object({ id: z.string(), text: z.string(), createdAt: z.string() })).default([]),
  /** Settings → Agents: API keys by variable name (only names in LOGIN_KEYS). Never returned by the API. */
  agentKeys: z.record(z.string(), z.string()).default({}),
  /** The agents' login files saved when a session ended: `{ relPathUnderHome: base64 }`. */
  agentLogins: z.record(z.string(), z.string()).default({}),
  /** Runs of remote (hosted) sessions, each in its own run container. Key: the run id. */
  hostedRuns: z.record(z.string(), hostedRunSchema).default({}),
});

export type Data = z.infer<typeof dataSchema>;
export type Forge = z.infer<typeof forgeSchema>;
export type SessionRecord = z.infer<typeof sessionSchema>;
export type SessionState = SessionRecord["state"];
export type SandboxRecord = Data["sandboxes"][string];
export type SandboxLimits = Data["sandboxLimits"];
export type HostedRunRecord = z.infer<typeof hostedRunSchema>;

/** The instance-wide settings (table `instance`), shared by all users. */
export const instanceSchema = z.object({
  /** Random 32 bytes as hex, created on first open. Signs the session cookie. */
  sessionSecret: z.string(),
  /** This graph-manager's id, on the images and gm-clis volumes it makes (`gm.instance`): its cleanup removes only its own. */
  instanceId: z.string().regex(/^[0-9a-f]{16}$/),
});
export type InstanceData = z.infer<typeof instanceSchema>;

/** The JSON file of graph-manager before the database; imported into the user `admin` on first start (db/import-json.ts). */
export const DATA_FILE = "graph-manager.json";

/** The projects of `d`, sorted by name. */
export function projectsOf(d: Data): Project[] {
  return Object.entries(d.projects)
    .map(([id, rec]) => toProject(id, rec))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function projectOf(d: Data, id: string): Project | undefined {
  const rec = Object.hasOwn(d.projects, id) ? d.projects[id] : undefined;
  return rec ? toProject(id, rec) : undefined;
}

/** A stored project record as a `Project`, with the derived `workspaces` (the local clone ids). */
export function toProject(id: string, rec: ProjectRecord): Project {
  return { id, name: rec.name, repos: structuredClone(rec.repos), workspaces: rec.repos.map(workspaceIdOf), createdAt: rec.createdAt };
}

/** A new user's data: the defaults and the built-in reviewers. */
export function newUserData(): Data {
  return { ...dataSchema.parse({}), reviewers: structuredClone([...BUILTIN_REVIEWERS]) };
}

/** Parses a stored `user_data.data`; throws `<what> is invalid: <path>: <message>; …`. */
export function parseUserData(json: unknown, what: string): Data {
  const parsed = dataSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${what} is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/** One user's settings. */
export interface UserStore {
  readonly user: User;
  get(): Data;
  /** Applies `fn` to a copy of the data and saves it. Updates run one at a time, in call order; a failed one changes nothing. */
  update(fn: (d: Data) => void): Promise<void>;
  /** The user's reviewers, disabled ones included. */
  reviewers(): Reviewer[];
}

/** graph-manager's state: the instance settings and a store per user. */
export interface Store {
  instance(): InstanceData;
  forUser(user: User): Promise<UserStore>;
  /** Deletes the user's data; a later `forUser` starts with a new user's defaults. */
  deleteUser(userId: string): Promise<void>;
}

class SqlUserStore implements UserStore {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    readonly user: User,
    private readonly db: Db,
    private data: Data,
  ) {}

  get(): Data {
    return this.data;
  }

  reviewers(): Reviewer[] {
    return this.data.reviewers ?? [];
  }

  update(fn: (d: Data) => void): Promise<void> {
    const run = async (): Promise<void> => {
      const next = structuredClone(this.data);
      fn(next);
      const valid = dataSchema.parse(next);
      const prev = this.data;
      this.data = valid;
      try {
        await this.write();
      } catch (err) {
        this.data = prev;
        throw err;
      }
    };
    const result = this.chain.then(run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  async write(): Promise<void> {
    await this.db.exec("UPDATE user_data SET data = ?, updated_at = ? WHERE user_id = ?", [
      JSON.stringify(this.data),
      new Date().toISOString(),
      this.user.id,
    ]);
  }
}

/** The Store over a Db (SQLite or Postgres): table `instance` and one JSON row per user in `user_data`. */
export class SqlStore implements Store {
  private readonly users = new Map<string, Promise<SqlUserStore>>();

  private constructor(
    readonly db: Db,
    private readonly inst: InstanceData,
  ) {}

  /**
   * Migrates the db, imports `<dataDir>/graph-manager.json` when given a data dir (into `admin`, once), and creates the
   * instance's session secret and id when missing.
   */
  static async open(db: Db, opts: { dataDir?: string } = {}): Promise<SqlStore> {
    await migrate(db);
    if (opts.dataDir !== undefined) await importJsonFile(db, opts.dataDir);
    const fresh: Record<keyof InstanceData, string> = {
      sessionSecret: randomBytes(32).toString("hex"),
      instanceId: randomBytes(8).toString("hex"),
    };
    for (const [key, value] of Object.entries(fresh)) {
      await db.exec("INSERT INTO instance (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING", [key, value]);
    }
    const rows = await db.query<{ key: string; value: string }>("SELECT key, value FROM instance");
    const inst = instanceSchema.parse(Object.fromEntries(rows.map((r) => [r.key, r.value])));
    return new SqlStore(db, inst);
  }

  instance(): InstanceData {
    return this.inst;
  }

  forUser(user: User): Promise<UserStore> {
    let store = this.users.get(user.id);
    if (!store) {
      store = this.load(user);
      this.users.set(user.id, store);
      store.catch(() => this.users.delete(user.id));
    }
    return store;
  }

  async deleteUser(userId: string): Promise<void> {
    // A load in flight inserts the row: wait for it. Pending updates only UPDATE, so after the DELETE they change nothing.
    const cached = this.users.get(userId);
    this.users.delete(userId);
    await cached?.catch(() => undefined);
    await this.db.exec("DELETE FROM user_data WHERE user_id = ?", [userId]);
  }

  private async load(user: User): Promise<SqlUserStore> {
    const select = (): Promise<{ data: string }[]> => this.db.query<{ data: string }>("SELECT data FROM user_data WHERE user_id = ?", [user.id]);
    let rows = await select();
    if (rows.length === 0) {
      await this.db.exec("INSERT INTO user_data (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING", [
        user.id,
        JSON.stringify(newUserData()),
        new Date().toISOString(),
      ]);
      rows = await select();
    }
    const text = rows[0]?.data;
    if (text === undefined) throw new Error(`user data of ${user.id} is missing`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`user data of ${user.id} is not valid JSON`);
    }
    const store = new SqlUserStore(user, this.db, parseUserData(json, `user data of ${user.id}`));
    if (store.get().reviewers === undefined) {
      store.get().reviewers = structuredClone([...BUILTIN_REVIEWERS]);
      await store.write();
    }
    return store;
  }
}
