import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { deleteUser, disableUser, getUser } from "../accounts.js";
import type { AppContext } from "../app.js";
import { passwordMatches } from "../auth.js";

/** Whether the request carries `Authorization: Bearer <GM_GATEWAY_SECRET>` (constant-time compare). */
function bearerOk(req: FastifyRequest, secret: string): boolean {
  const header = req.headers.authorization;
  const m = typeof header === "string" ? /^Bearer (.+)$/.exec(header) : null;
  return !!m?.[1] && !!secret && passwordMatches(m[1], secret);
}

/**
 * The gateway's server-to-server user management (`GM_AUTH=gateway` only; otherwise these routes don't exist): disable
 * or delete a user. Authenticated by `GM_GATEWAY_SECRET` as a bearer token, not by the session hook.
 */
export async function gatewayRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  if (ctx.config.auth !== "gateway") return;
  const secret = ctx.config.gatewaySecret ?? "";

  const check = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!bearerOk(req, secret)) await reply.code(401).send({ error: "wrong gateway secret" });
  };

  app.post<{ Params: { id: string } }>("/api/gateway/users/:id/disable", { preHandler: check }, async (req, reply) => {
    const { id } = req.params;
    if (!(await getUser(ctx.db, id))) return reply.code(404).send({ error: "no such user" });
    await disableUser(ctx.db, id);
    await ctx.userLifecycle.disabled(id);
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>("/api/gateway/users/:id", { preHandler: check }, async (req, reply) => {
    const { id } = req.params;
    if (!(await getUser(ctx.db, id))) return reply.code(404).send({ error: "no such user" });
    // The user's data, run rows and blobs (hooks of the features that own them), then the account.
    await ctx.userLifecycle.deleted(id);
    await deleteUser(ctx.db, id);
    return reply.code(204).send();
  });
}
