import { access, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ADMIN_USER } from "../identity.js";
import { DATA_FILE, dataSchema, newUserData, type Data, type InstanceData } from "../store.js";
import type { Db } from "./db.js";

/** The user the JSON file's data belongs to. */
const ADMIN_ID = ADMIN_USER.id;

/** The suffix a JSON file gets once imported. */
export const IMPORTED_SUFFIX = ".imported";

/** Reads graph-manager's JSON file of before the database (`<dataDir>/graph-manager.json`). */
export class JsonFileStore {
  /** The file's instance settings and data, or undefined when there is no file. Throws when it is not valid. */
  static async read(dataDir: string): Promise<{ instance: Partial<InstanceData>; data: Data } | undefined> {
    const file = path.join(dataDir, DATA_FILE);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${file} is not valid JSON`);
    }
    // Built here, not at module level: store.ts imports this module.
    const fileSchema = dataSchema.extend({ sessionSecret: z.string(), instanceId: z.string().regex(/^[0-9a-f]{16}$/).optional() });
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success) throw new Error(`${file} is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const { sessionSecret, instanceId, ...rest } = parsed.data;
    const data = dataSchema.parse(rest);
    if (data.reviewers === undefined) data.reviewers = newUserData().reviewers;
    return { instance: { sessionSecret, ...(instanceId !== undefined ? { instanceId } : {}) }, data };
  }
}

/**
 * Imports `<dataDir>/graph-manager.json` into the user `admin` (and its session secret and instance id into `instance`,
 * so cookies and Docker labels survive), then renames it `graph-manager.json.imported`. Does nothing, and returns
 * false, when there is no file or `admin` already has data.
 */
export async function importJsonFile(db: Db, dataDir: string): Promise<boolean> {
  const file = path.join(dataDir, DATA_FILE);
  try {
    await access(file);
  } catch {
    return false;
  }
  const existing = await db.query("SELECT user_id FROM user_data WHERE user_id = ?", [ADMIN_ID]);
  if (existing.length > 0) return false;
  const read = await JsonFileStore.read(dataDir);
  if (!read) return false;
  const imported = await db.transaction(async (tx) => {
    // Checked again inside the transaction: another process may have imported meanwhile.
    if ((await tx.query("SELECT user_id FROM user_data WHERE user_id = ?", [ADMIN_ID])).length > 0) return false;
    await tx.exec("INSERT INTO user_data (user_id, data, updated_at) VALUES (?, ?, ?)", [ADMIN_ID, JSON.stringify(read.data), new Date().toISOString()]);
    for (const [key, value] of Object.entries(read.instance)) {
      await tx.exec("INSERT INTO instance (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value]);
    }
    return true;
  });
  if (imported) await rename(file, `${file}${IMPORTED_SUFFIX}`);
  return imported;
}
