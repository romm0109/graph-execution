import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { reviewersFileSchema, type Reviewer } from "graph-execution/api";

/** The reviewers file every run started from graph-manager gets as GRAPH_EXECUTION_REVIEWERS. */
export const REVIEWERS_JSON = "reviewers.json";
export const reviewersFilePath = (dataDir: string): string => path.join(dataDir, REVIEWERS_JSON);

/** Writes `<dataDir>/reviewers.json` with the enabled reviewers: `<file>.tmp` with mode 600, then a rename. */
export async function writeReviewersFile(dataDir: string, reviewers: readonly Reviewer[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = reviewersFilePath(dataDir);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ reviewers: reviewers.filter((r) => r.enabled) }, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

/**
 * Validates a whole reviewer list with the engine's schema (so graph-manager and the engine accept the same lists).
 * The error is the first issue, as `<field>: <message>` with the `reviewers.<i>.` prefix dropped.
 */
export function validateList(list: unknown[]): { ok: true; reviewers: Reviewer[] } | { ok: false; error: string } {
  const result = reviewersFileSchema.safeParse({ reviewers: list });
  if (result.success) return { ok: true, reviewers: result.data.reviewers };
  const issue = result.error.issues[0];
  if (!issue) return { ok: false, error: "invalid reviewer" };
  const rel = issue.path[0] === "reviewers" ? issue.path.slice(2) : issue.path;
  const where = rel.map(String).join(".");
  const field = rel[0] === undefined ? undefined : String(rel[0]);
  // The engine's messages often name the field already (`id: …`, `invalid glob "…": …`).
  const named = field === undefined || issue.message.startsWith(`${field}:`) || issue.message.startsWith("invalid glob ");
  return { ok: false, error: named ? issue.message : `${where}: ${issue.message}` };
}
