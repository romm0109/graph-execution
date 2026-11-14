// Settings → Agents (docs/prd/hosted-sessions.md): API keys that log the user's agents in. Values are never returned.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { agentKeyNames, isAgentKeyName } from "../sessions/logins.js";

const putBody = z.object({ value: z.string().trim().min(1).max(4096) }).strict();

const unknownName = (name: string) => ({ error: `${name} is not an agent login key` });

export async function agentKeyRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/settings/agent-keys", async (req) => {
    const saved = (await ctx.store.forUser(req.user)).get().agentKeys;
    return { keys: agentKeyNames().map((k) => ({ ...k, saved: (saved[k.name] ?? "") !== "" })) };
  });

  app.put<{ Params: { name: string } }>("/api/settings/agent-keys/:name", async (req, reply) => {
    const { name } = req.params;
    if (!isAgentKeyName(name)) return reply.code(400).send(unknownName(name));
    const parsed = putBody.safeParse(req.body ?? {});
    // Never echo the value: the error names the field only.
    if (!parsed.success) return reply.code(400).send({ error: "value: a non-empty string of at most 4096 characters is required" });
    const value = parsed.data.value;
    await (await ctx.store.forUser(req.user)).update((d) => {
      d.agentKeys[name] = value;
    });
    return reply.code(204).send();
  });

  app.delete<{ Params: { name: string } }>("/api/settings/agent-keys/:name", async (req, reply) => {
    const { name } = req.params;
    if (!isAgentKeyName(name)) return reply.code(400).send(unknownName(name));
    await (await ctx.store.forUser(req.user)).update((d) => {
      delete d.agentKeys[name];
    });
    return reply.code(204).send();
  });
}
