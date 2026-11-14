import path from "node:path";
import type { Config } from "../config.js";
import { PostgresDb } from "./postgres.js";
import { SqliteDb } from "./sqlite.js";

export type Dialect = "sqlite" | "postgres";

/** A small SQL database: SQLite (default) or Postgres (`GM_DATABASE_URL`). Values are strings, numbers or null. */
export interface Db {
  readonly dialect: Dialect;
  /** Rows of a SELECT (or of a statement with RETURNING). Placeholders are `?` in both dialects. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** A statement without rows. A string without params may hold several statements (migrations). */
  exec(sql: string, params?: unknown[]): Promise<void>;
  /** Runs `fn` in one transaction: COMMIT when it resolves, ROLLBACK when it throws. */
  transaction<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** The SQLite file in the data dir. */
export const DB_FILE = "graph-manager.db";

/** Opens Postgres when `databaseUrl` is set, else `<dataDir>/graph-manager.db`. Throws `ConfigError` when it can't. */
export async function openDb(config: Pick<Config, "dataDir" | "databaseUrl">): Promise<Db> {
  if (config.databaseUrl) return PostgresDb.connect(config.databaseUrl);
  return SqliteDb.open(path.join(config.dataDir, DB_FILE));
}
