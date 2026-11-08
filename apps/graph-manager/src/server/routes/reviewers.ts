import type { FastifyInstance } from "fastify";
import { BUILTIN_INSTRUCTIONS, BUILTIN_REVIEWERS, REVIEWER_PROVIDERS, type Reviewer } from "graph-execution/api";
import type { AppContext } from "../app.js";
import { reviewersFilePath, validateList, writeReviewersFile } from "../reviewers.js";

const BUILTIN_IDS = ["code", "tester"] as const;
type BuiltinId = (typeof BUILTIN_IDS)[number];
const isBuiltin = (id: string): id is BuiltinId => (BUILTIN_IDS as readonly string[]).includes(id);

/** A 4xx answer thrown from inside a store update (the app's error handler passes `statusCode` through). */
class ReviewerError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `SECURITY_REVIEW.md` for `security`, `API_DOCS_REVIEW.md` for `api-docs`. */
export const defaultRepoFile = (id: string): string => `${id.toUpperCase().replaceAll("-", "_")}_REVIEW.md`;

function validOrThrow(list: unknown[]): Reviewer[] {
  const result = validateList(list);
  if (!result.ok) throw new ReviewerError(400, result.error);
  return result.reviewers;
}

export async function reviewerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const dataDir = ctx.config.dataDir;
  /** Runs `fn` on the current list inside a store update, saves the list it returns and rewrites reviewers.json. */
  const change = async (fn: (current: Reviewer[]) => Reviewer[]): Promise<Reviewer[]> => {
    let next: Reviewer[] = [];
    await ctx.store.update((d) => {
      next = fn(d.reviewers ?? []);
      d.reviewers = next;
    });
    await writeReviewersFile(dataDir, ctx.store.reviewers());
    return next;
  };

  app.get("/api/reviewers", async () => ({
    reviewers: ctx.store.reviewers(),
    builtinIds: [...BUILTIN_IDS],
    providers: [...REVIEWER_PROVIDERS],
    file: reviewersFilePath(dataDir),
  }));

  app.post("/api/reviewers", async (req, reply) => {
    if (!isObject(req.body)) return reply.code(400).send({ error: "the body must be a reviewer object" });
    const body: Record<string, unknown> = { ...req.body };
    if ((body.repoFile === undefined || body.repoFile === "") && typeof body.id === "string") body.repoFile = defaultRepoFile(body.id);
    const list = await change((current) => validOrThrow([...current, body]));
    return reply.code(201).send({ reviewer: list[list.length - 1] });
  });

  app.put<{ Params: { id: string } }>("/api/reviewers/:id", async (req, reply) => {
    const { id } = req.params;
    if (!isObject(req.body)) return reply.code(400).send({ error: "the body must be a reviewer object" });
    const body = req.body;
    if (body.id === undefined) return reply.code(400).send({ error: "the body must be the whole reviewer (id missing)" });
    if (body.id !== id) return reply.code(400).send({ error: "id: cannot be changed" });
    const list = await change((current) => {
      const i = current.findIndex((r) => r.id === id);
      if (i < 0) throw new ReviewerError(404, "unknown reviewer");
      return validOrThrow(current.map((r, j) => (j === i ? body : r)));
    });
    return { reviewer: list.find((r) => r.id === id) };
  });

  app.delete<{ Params: { id: string } }>("/api/reviewers/:id", async (req, reply) => {
    const { id } = req.params;
    if (id === "tester") return reply.code(400).send({ error: "the live tester can be disabled, not deleted" });
    await change((current) => {
      if (!current.some((r) => r.id === id)) throw new ReviewerError(404, "unknown reviewer");
      return current.filter((r) => r.id !== id);
    });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/reviewers/reset/:id", async (req, reply) => {
    const { id } = req.params;
    if (!isBuiltin(id)) return reply.code(400).send({ error: "only code and tester have built-in instructions" });
    const list = await change((current) => {
      if (current.some((r) => r.id === id)) return validOrThrow(current.map((r) => (r.id === id ? { ...r, instructions: BUILTIN_INSTRUCTIONS[id] } : r)));
      const builtin = structuredClone(BUILTIN_REVIEWERS.find((r) => r.id === id)!);
      return validOrThrow(id === "code" ? [builtin, ...current] : [...current, builtin]);
    });
    return { reviewer: list.find((r) => r.id === id) };
  });
}
