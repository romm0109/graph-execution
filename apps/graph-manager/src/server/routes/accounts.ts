import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AccountError,
  MIN_PASSWORD,
  SHORT_PASSWORD_MESSAGE,
  USERNAME_MESSAGE,
  createUser,
  getUser,
  hashPassword,
  setDisplayName,
  setPassword,
  toUser,
  usePasswordLink,
  validUsername,
  verifyPassword,
  type UserRow,
} from "../accounts.js";
import type { AppContext } from "../app.js";
import { NOT_IN_GATEWAY_MODE, issueSession } from "../auth.js";

const DISPLAY_NAME_MAX = 64;
const DISPLAY_NAME_MESSAGE = `display name must be 1–${String(DISPLAY_NAME_MAX)} characters`;

const signupBody = z.object({ username: z.string(), displayName: z.string().optional(), password: z.string() });
const setPasswordBody = z.object({ token: z.string(), password: z.string() });
const patchBody = z.object({ displayName: z.string().optional(), currentPassword: z.string().optional(), newPassword: z.string().optional() });

function checkPassword(pw: string): void {
  if (pw.length < MIN_PASSWORD) throw new AccountError(400, SHORT_PASSWORD_MESSAGE);
}

function accountOf(row: UserRow): { id: string; username: string; displayName: string } {
  return { id: row.id, username: row.username, displayName: row.displayName };
}

/** Open sign-up, the set-password links (invite and reset) and the signed-in user's own account. */
export async function accountRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /** In gateway mode the gateway owns the accounts: none of these routes exist. */
  const builtinOnly = (): void => {
    if (ctx.config.auth === "gateway") throw new AccountError(404, NOT_IN_GATEWAY_MODE);
  };

  /** Ends every session of `userId` issued until now and returns the time to issue the caller's new cookie at. */
  const endSessions = async (row: UserRow): Promise<number> => {
    const validAfter = Date.now() + 1;
    await (await ctx.store.forUser(toUser(row))).update((d) => {
      d.sessionsValidAfter = validAfter;
    });
    return validAfter;
  };

  app.post("/api/auth/signup", async (req, reply) => {
    builtinOnly();
    if (ctx.config.signup !== "open") throw new AccountError(404, "sign-up is closed");
    const body = signupBody.parse(req.body ?? {});
    const username = body.username.trim().toLowerCase();
    if (!validUsername(username)) throw new AccountError(400, USERNAME_MESSAGE);
    checkPassword(body.password);
    const displayName = (body.displayName ?? "").trim() || username;
    if (displayName.length > DISPLAY_NAME_MAX) throw new AccountError(400, DISPLAY_NAME_MESSAGE);
    const row = await createUser(ctx.db, { username, displayName, passwordHash: await hashPassword(body.password) });
    issueSession(reply, ctx, row.id);
    return reply.code(204).send();
  });

  app.post("/api/auth/set-password", async (req, reply) => {
    builtinOnly();
    const body = setPasswordBody.parse(req.body ?? {});
    checkPassword(body.password);
    const row = await usePasswordLink(ctx.db, body.token);
    if (!row) throw new AccountError(400, "link expired or used");
    if (row.disabled) throw new AccountError(403, "account disabled");
    await setPassword(ctx.db, row.id, await hashPassword(body.password));
    issueSession(reply, ctx, row.id, await endSessions(row));
    return reply.code(204).send();
  });

  const current = async (id: string): Promise<UserRow> => {
    const row = await getUser(ctx.db, id);
    if (!row) throw new AccountError(401, "login required");
    return row;
  };

  app.get("/api/account", async (req) => {
    builtinOnly();
    return accountOf(await current(req.user.id));
  });

  app.patch("/api/account", async (req, reply) => {
    builtinOnly();
    const body = patchBody.parse(req.body ?? {});
    const row = await current(req.user.id);
    let displayName: string | undefined;
    if (body.displayName !== undefined) {
      displayName = body.displayName.trim();
      if (displayName === "" || displayName.length > DISPLAY_NAME_MAX) throw new AccountError(400, DISPLAY_NAME_MESSAGE);
    }
    if (body.newPassword !== undefined) {
      if (body.currentPassword === undefined || !(await verifyPassword(body.currentPassword, row.passwordHash))) {
        throw new AccountError(400, "current password is wrong");
      }
      checkPassword(body.newPassword);
    }
    if (displayName !== undefined) await setDisplayName(ctx.db, row.id, displayName);
    if (body.newPassword !== undefined) {
      await setPassword(ctx.db, row.id, await hashPassword(body.newPassword));
      // Every other cookie of the user stops working; this browser gets a new one.
      issueSession(reply, ctx, row.id, await endSessions(row));
    }
    return accountOf(await current(row.id));
  });
}
