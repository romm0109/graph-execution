import pg from "pg";
import { ConfigError } from "../config.js";
import type { Db } from "./db.js";
import { normalizeParams } from "./params.js";

const { Pool } = pg;

/** `?` placeholders as Postgres's `$1`, `$2`, …; SQL in this code base never contains a literal `?`. */
export function toPgParams(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${String(++n)}`);
}

type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

async function runQuery<T>(q: Queryable, sql: string, params: unknown[] | undefined): Promise<T[]> {
  const res = params === undefined ? await q.query(sql) : await q.query(toPgParams(sql), normalizeParams(params));
  // A multi-statement string returns one result per statement.
  const last = Array.isArray(res) ? res[res.length - 1] : res;
  return ((last as pg.QueryResult | undefined)?.rows ?? []) as T[];
}

/** A Db over one client of the pool, inside a transaction. */
class ClientDb implements Db {
  readonly dialect = "postgres" as const;
  constructor(private readonly client: pg.PoolClient) {}
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    return runQuery<T>(this.client, sql, params);
  }
  async exec(sql: string, params?: unknown[]): Promise<void> {
    await runQuery(this.client, sql, params);
  }
  transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    // Already in one: nest into it.
    return fn(this);
  }
  async close(): Promise<void> {
    // The pool owns the client.
  }
}

/** Postgres over a `pg` Pool. */
export class PostgresDb implements Db {
  readonly dialect = "postgres" as const;

  private constructor(private readonly pool: pg.Pool) {}

  /** Connects and checks with `SELECT 1`. With `schema`, creates it and uses it as the search_path (tests). */
  static async connect(url: string, opts: { schema?: string } = {}): Promise<PostgresDb> {
    const fail = (err: unknown): ConfigError => new ConfigError(`Cannot connect to the database: ${(err as Error).message}`);
    let pool: pg.Pool | undefined;
    try {
      if (opts.schema !== undefined) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.schema)) throw new Error(`invalid schema name ${opts.schema}`);
        const setup = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10000 });
        try {
          await setup.query(`CREATE SCHEMA IF NOT EXISTS "${opts.schema}"`);
        } finally {
          await setup.end();
        }
      }
      pool = new Pool({
        connectionString: url,
        connectionTimeoutMillis: 10000,
        ...(opts.schema !== undefined ? { options: `-c search_path=${opts.schema}` } : {}),
      });
      // An idle client's error (the server went away) must not crash the process.
      pool.on("error", () => undefined);
      await pool.query("SELECT 1");
      return new PostgresDb(pool);
    } catch (err) {
      if (pool) await pool.end().catch(() => undefined);
      throw fail(err);
    }
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    return runQuery<T>(this.pool, sql, params);
  }

  async exec(sql: string, params?: unknown[]): Promise<void> {
    await runQuery(this.pool, sql, params);
  }

  async transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const result = await fn(new ClientDb(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
