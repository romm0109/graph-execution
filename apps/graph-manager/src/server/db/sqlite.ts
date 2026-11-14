import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ConfigError } from "../config.js";
import type { Db } from "./db.js";
import { normalizeParams } from "./params.js";

/**
 * The params as better-sqlite3 binds them: booleans as 0/1, and integers as BigInt, which it binds as INTEGER (a JS
 * number is bound as REAL, so a TEXT column would get "1.0" where Postgres stores "1").
 */
function bind(params: unknown[] | undefined): unknown[] {
  return normalizeParams(params).map((p) => (typeof p === "number" && Number.isSafeInteger(p) ? BigInt(p) : p));
}

/** SQLite over better-sqlite3 (synchronous); one connection, transactions serialized. */
export class SqliteDb implements Db {
  readonly dialect = "sqlite" as const;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(private readonly db: Database.Database) {}

  /** Opens (or creates) `file` with mode 600, WAL and foreign keys; `":memory:"` gives a private in-memory db. */
  static async open(file: string): Promise<SqliteDb> {
    const memory = file === ":memory:";
    try {
      if (!memory) mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const db = new Database(file);
      try {
        db.pragma("journal_mode = WAL");
        db.pragma("busy_timeout = 5000");
        db.pragma("foreign_keys = ON");
        if (!memory && process.platform !== "win32") chmodSync(file, 0o600);
      } catch (err) {
        db.close();
        throw err;
      }
      return new SqliteDb(db);
    } catch (err) {
      throw new ConfigError(`Cannot connect to the database: ${(err as Error).message}`);
    }
  }

  /** Runs a statement now (inside a transaction, or once no transaction is open). */
  private queryNow<T>(sql: string, params?: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    const args = bind(params);
    if (!stmt.reader) {
      stmt.run(...args);
      return [];
    }
    return stmt.all(...args) as T[];
  }

  private execNow(sql: string, params?: unknown[]): void {
    if (params === undefined) this.db.exec(sql);
    else this.db.prepare(sql).run(...bind(params));
  }

  // Statements outside a transaction wait for the open one (its `fn` awaits between statements on this one
  // connection): otherwise they would run inside it and be rolled back with it.
  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    await this.chain;
    return this.queryNow<T>(sql, params);
  }

  async exec(sql: string, params?: unknown[]): Promise<void> {
    await this.chain;
    this.execNow(sql, params);
  }

  transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    // The handle `fn` gets runs its statements at once, inside the transaction; a nested transaction joins it.
    const tx: Db = {
      dialect: this.dialect,
      query: async <R>(sql: string, params?: unknown[]) => this.queryNow<R>(sql, params),
      exec: async (sql: string, params?: unknown[]) => this.execNow(sql, params),
      transaction: <R>(inner: (db: Db) => Promise<R>) => inner(tx),
      close: () => Promise.reject(new Error("cannot close the database inside a transaction")),
    };
    const run = async (): Promise<T> => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(tx);
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        if (this.db.inTransaction) this.db.exec("ROLLBACK");
        throw err;
      }
    };
    const result = this.chain.then(run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    // Waits for an open transaction, so it is not cut off.
    await this.chain;
    if (this.db.open) this.db.close();
  }
}
