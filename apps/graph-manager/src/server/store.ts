import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameReplacing } from "graph-execution/api";
import { z } from "zod";

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
  /** Pull requests opened from runs. Key: `${workspaceId}/${runId}`. */
  prs: z
    .record(
      z.string(),
      z.object({ url: z.string(), number: z.number(), branch: z.string(), base: z.string().optional(), forge: forgeSchema, createdAt: z.string() }),
    )
    .default({}),
  /** Session nonces revoked by logout, with the session's expiry (ms) so they can be pruned once it has passed. */
  revokedSessions: z.record(z.string(), z.number()).default({}),
});

export type Data = z.infer<typeof dataSchema>;
export type Forge = z.infer<typeof forgeSchema>;

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
    return new DataStore(file, parsed.data);
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
