import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, Dialect } from "./db.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

const NAME = /^(\d{3})-[A-Za-z0-9_-]+?(?:\.(sqlite|postgres))?\.sql$/;

export interface Migration {
  version: number;
  file: string;
}

/** The migrations of `dialect` in `dir`, by version: `NNN-name.sql` (both) or `NNN-name.<dialect>.sql`. */
export async function listMigrations(dialect: Dialect, dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const byVersion = new Map<number, string>();
  for (const name of (await readdir(dir)).sort()) {
    const m = NAME.exec(name);
    if (!m) continue;
    const only = m[2] as Dialect | undefined;
    if (only !== undefined && only !== dialect) continue;
    const version = Number(m[1]);
    if (byVersion.has(version)) throw new Error(`duplicate migration ${m[1] ?? ""}`);
    byVersion.set(version, path.join(dir, name));
  }
  return [...byVersion].sort(([a], [b]) => a - b).map(([version, file]) => ({ version, file }));
}

/**
 * Applies, in one transaction and in ascending order, every migration not applied yet (also one below the highest
 * applied: parallel features add numbers in any order). Returns the versions applied.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<number[]> {
  const migrations = await listMigrations(db.dialect, dir);
  await db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)");
  return db.transaction(async (tx) => {
    const rows = await tx.query<{ version: number | string }>("SELECT version FROM schema_version");
    const applied = new Set(rows.map((r) => Number(r.version)));
    const done: number[] = [];
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      await tx.exec(await readFile(m.file, "utf8"));
      await tx.exec("INSERT INTO schema_version (version) VALUES (?)", [m.version]);
      done.push(m.version);
    }
    return done;
  });
}
