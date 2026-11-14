import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BUILTIN_REVIEWERS, renameReplacing, reviewerSchema, type Reviewer } from "graph-execution/api";
import { z } from "zod";
import type { Project } from "./projects.js";
import { migrateRecipe, recipeSchema } from "./sandbox-image.js";

const forgeSchema = z.enum(["github", "gitlab"]);

export const dataSchema = z.object({
  /** Random 32 bytes as hex, created on first open. Signs the session cookie. */
  sessionSecret: z.string(),
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
  /** This graph-manager's id, on the images and gm-clis volumes it makes (`gm.instance`): its cleanup removes only its own. */
  instanceId: z.string().regex(/^[0-9a-f]{16}$/).default(() => randomBytes(8).toString("hex")),
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
  /** Projects (docs/prd/multi-repo.md): named groups of workspaces of one forge. Key: the project id (the name's slug). */
  projects: z
    .record(z.string(), z.object({ name: z.string(), workspaces: z.array(z.string()), createdAt: z.string() }))
    .default({}),
});

export type Data = z.infer<typeof dataSchema>;
export type Forge = z.infer<typeof forgeSchema>;
export type SandboxRecord = Data["sandboxes"][string];
export type SandboxLimits = Data["sandboxLimits"];

export const DATA_FILE = "graph-manager.json";

/** graph-manager's state: one JSON file in the data dir, written atomically with mode 600. */
export class DataStore {
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    readonly file: string,
    private data: Data,
  ) {}

  /** Loads `<dataDir>/graph-manager.json`, or creates it with a new session secret. Throws when the file is invalid. */
  static async open(dataDir: string): Promise<DataStore> {
    await mkdir(dataDir, { recursive: true });
    const file = path.join(dataDir, DATA_FILE);
    let text: string | undefined;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (text === undefined) {
      const store = new DataStore(file, dataSchema.parse({ sessionSecret: randomBytes(32).toString("hex") }));
      store.seedReviewers();
      await store.write();
      return store;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${file} is not valid JSON`);
    }
    const parsed = dataSchema.safeParse(json);
    if (!parsed.success) throw new Error(`${file} is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const store = new DataStore(file, parsed.data);
    // A file from before instanceId got one generated just now: keep it, or it would change at every start.
    const newId = typeof json !== "object" || json === null || !("instanceId" in json);
    if (store.seedReviewers() || newId) await store.write();
    return store;
  }

  /** Sets the built-in reviewers when the data has none yet; true when it did. */
  private seedReviewers(): boolean {
    if (this.data.reviewers !== undefined) return false;
    this.data.reviewers = structuredClone([...BUILTIN_REVIEWERS]);
    return true;
  }

  /** The global reviewers, disabled ones included. */
  reviewers(): Reviewer[] {
    return this.data.reviewers ?? [];
  }

  /** The projects, sorted by name. */
  projects(): Project[] {
    return Object.entries(this.data.projects)
      .map(([id, rec]) => ({ id, ...rec }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  project(id: string): Project | undefined {
    const rec = Object.hasOwn(this.data.projects, id) ? this.data.projects[id] : undefined;
    return rec ? { id, ...rec } : undefined;
  }

  get(): Data {
    return this.data;
  }

  /** Applies `fn` to a copy of the data and saves it. Updates run one at a time, in call order. */
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

  /** Writes `<file>.tmp` then renames it over the file, so readers never see a partial file. */
  private async write(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await renameReplacing(tmp, this.file);
  }
}
