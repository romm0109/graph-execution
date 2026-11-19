/** Admin routes for API tokens (cookie session only; not under /api/v1, so a bearer token gets 401 here). */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { Data } from "../store.js";
import { API_SCOPES, hashToken, newToken, newTokenId, publicToken, type PublicToken } from "../tokens.js";

const createBody = z.object({
  name: z.string().trim().min(1, "name is required").max(100),
  scopes: z.array(z.enum(API_SCOPES)).min(1, "pick at least one scope"),
});

/** The stored tokens without their hashes, newest first. */
export function listTokens(data: Data): PublicToken[] {
  return Object.entries(data.apiTokens)
    .map(([id, t]) => publicToken(id, t))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export async function tokenRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/tokens", async () => ({ tokens: listTokens(ctx.store.get()) }));

  app.post("/api/tokens", async (req, reply) => {
    const body = createBody.parse(req.body ?? {});
    const scopes = [...new Set(body.scopes)];
    const id = newTokenId();
    const token = newToken();
    const createdAt = new Date().toISOString();
    await ctx.store.update((d) => {
      d.apiTokens[id] = { name: body.name, hash: hashToken(token), scopes, createdAt, createdBy: "admin" };
    });
    return reply.code(201).send({ id, name: body.name, scopes, createdAt, createdBy: "admin", token });
  });

  app.delete<{ Params: { id: string } }>("/api/tokens/:id", async (req, reply) => {
    const { id } = req.params;
    if (!Object.hasOwn(ctx.store.get().apiTokens, id)) return reply.code(404).send({ error: "unknown token" });
    await ctx.store.update((d) => {
      delete d.apiTokens[id];
    });
    return reply.code(204).send();
  });
}
