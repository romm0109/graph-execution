import { parseArgs } from "node:util";
import {
  AccountError,
  USERNAME_MESSAGE,
  createPasswordLink,
  createUser,
  disableUser,
  findUserByUsername,
  listUsers,
  validUsername,
  type UserRow,
} from "../accounts.js";
import { ConfigError, loadConfig } from "../config.js";
import { openDb, type Db } from "../db/db.js";
import { migrate } from "../db/migrate.js";
import { browserUrl } from "../main.js";

export interface Out {
  log: (line: string) => void;
  error: (line: string) => void;
}

export const USERS_USAGE = `usage: graph-manager users <command>

  add <username> [--name <display name>] [--url <base>]   create a user and print a set-password link
  list                                                    list the users
  reset <username> [--url <base>]                         print a new set-password link
  disable <username>                                      disable a user (their sign-ins stop at once)`;

class UsageError extends Error {}

function status(u: UserRow): string {
  if (u.disabled) return "disabled";
  return u.passwordHash === null ? "no password" : "active";
}

/**
 * `graph-manager users add|list|reset|disable`: manages the accounts in the server's database (the same `GM_*`
 * variables as the server). Returns the exit code: 0 ok, 1 an error, 2 bad usage.
 */
export async function usersCommand(argv: string[], env: NodeJS.ProcessEnv, out: Out = { log: console.log, error: console.error }): Promise<number> {
  const parse = () =>
    parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: { name: { type: "string" }, url: { type: "string" } },
    });
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse();
  } catch (err) {
    out.error(`error: ${(err as Error).message}`);
    out.error(USERS_USAGE);
    return 2;
  }
  const [sub, ...args] = parsed.positionals;
  const takesName = sub === "add" || sub === "reset" || sub === "disable";
  if (!(takesName && args.length === 1) && !(sub === "list" && args.length === 0)) {
    out.error(USERS_USAGE);
    return 2;
  }

  let db: Db | undefined;
  try {
    const config = loadConfig(env);
    if (config.auth === "gateway") {
      out.error("error: accounts are managed by the gateway (GM_AUTH=gateway)");
      return 2;
    }
    db = await openDb(config);
    await migrate(db);
    const base = (parsed.values.url ?? browserUrl(config.host, config.port)).replace(/\/+$/, "");
    const linkLine = (token: string): string => `Set-password link (valid 7 days, works once): ${base}/set-password?token=${token}`;
    const existing = async (username: string): Promise<UserRow> => {
      const u = await findUserByUsername(db as Db, username);
      if (!u) throw new UsageError(`no user ${username}`);
      return u;
    };
    const username = (args[0] ?? "").trim().toLowerCase();
    switch (sub) {
      case "add": {
        if (!validUsername(username)) throw new UsageError(USERNAME_MESSAGE);
        const displayName = parsed.values.name?.trim() || username;
        const u = await createUser(db, { username, displayName });
        out.log(`Created user ${u.username}.`);
        out.log(linkLine(await createPasswordLink(db, u.id)));
        break;
      }
      case "list": {
        const users = await listUsers(db);
        if (users.length === 0) out.log("No users.");
        for (const u of users) out.log(`${u.username}\t${u.displayName}\t${u.createdAt.slice(0, 10)}\t${status(u)}`);
        break;
      }
      case "reset": {
        const u = await existing(username);
        out.log(linkLine(await createPasswordLink(db, u.id)));
        break;
      }
      case "disable": {
        const u = await existing(username);
        await disableUser(db, u.id);
        out.log(`Disabled ${u.username}. A running graph-manager ends their terminals and sessions within a minute.`);
        break;
      }
    }
    return 0;
  } catch (err) {
    if (err instanceof UsageError || err instanceof AccountError || err instanceof ConfigError) {
      out.error(`error: ${err.message}`);
      return 1;
    }
    throw err;
  } finally {
    await db?.close();
  }
}
