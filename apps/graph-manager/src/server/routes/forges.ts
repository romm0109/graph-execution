import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { ForgeError, clientFor, forgeClient, gitlabApiUrl, type ForgeKind } from "../forges.js";

const kindSchema = z.enum(["github", "gitlab"]);
const githubBody = z.object({ token: z.string().trim().min(1, "token is required") });
const gitlabBody = z.object({
  token: z.string().trim().min(1, "token is required"),
  baseUrl: z.string().trim().optional(),
});

/** `https://gitlab.com` when empty; no trailing slashes; must be http(s). */
export function normalizeBaseUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim().replace(/\/+$/, "") || "https://gitlab.com";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ForgeError(400, "baseUrl must be an http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ForgeError(400, "baseUrl must be an http(s) URL");
  return value;
}

/** The last 4 characters of a token, or undefined for tokens of 4 characters or fewer (never reveal a whole token). */
export function tokenEnd(token: string): string | undefined {
  return token.length > 4 ? token.slice(-4) : undefined;
}

/** The public view of a stored forge: never the token itself, only its last 4 characters. */
function publicInfo(token: string, login: string, apiUrl: string, extra: { baseUrl?: string } = {}) {
  const end = tokenEnd(token);
  return { connected: true as const, login, ...extra, apiUrl, ...(end ? { tokenEnd: end } : {}) };
}

export async function forgeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/forges", async () => {
    const { github, gitlab } = ctx.store.get().forges;
    return {
      github: github ? publicInfo(github.token, github.login, ctx.config.githubApiUrl) : { connected: false },
      gitlab: gitlab ? publicInfo(gitlab.token, gitlab.login, gitlab.baseUrl, { baseUrl: gitlab.baseUrl }) : { connected: false },
    };
  });

  app.put("/api/forges/github", async (req) => {
    const { token } = githubBody.parse(req.body);
    const { login } = await forgeClient({ kind: "github", token, apiUrl: ctx.config.githubApiUrl }).verify();
    await ctx.store.update((d) => {
      d.forges.github = { token, login };
    });
    return publicInfo(token, login, ctx.config.githubApiUrl);
  });

  app.put("/api/forges/gitlab", async (req) => {
    const body = gitlabBody.parse(req.body);
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const { login } = await forgeClient({ kind: "gitlab", token: body.token, apiUrl: gitlabApiUrl(baseUrl) }).verify();
    await ctx.store.update((d) => {
      d.forges.gitlab = { token: body.token, login, baseUrl };
    });
    return publicInfo(body.token, login, baseUrl, { baseUrl });
  });

  app.delete<{ Params: { kind: string } }>("/api/forges/:kind", async (req, reply) => {
    const kind: ForgeKind = kindSchema.parse(req.params.kind);
    await ctx.store.update((d) => {
      delete d.forges[kind];
    });
    return reply.code(204).send();
  });

  app.get<{ Params: { kind: string }; Querystring: { q?: string } }>("/api/forges/:kind/repos", async (req) => {
    const kind: ForgeKind = kindSchema.parse(req.params.kind);
    const repos = await clientFor(ctx, kind).listRepos(typeof req.query.q === "string" ? req.query.q : undefined);
    return { repos };
  });
}
