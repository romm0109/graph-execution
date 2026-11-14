import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { reviewersFileSchema, type Reviewer, renameReplacing } from "graph-execution/api";
import { userKeySegment } from "./blobs.js";
import type { User } from "./identity.js";
import type { UserStore } from "./store.js";

/** The legacy instance-wide reviewers file (no user given). */
export const REVIEWERS_JSON = "reviewers.json";
/** The folder of the per-user reviewers files: `<dataDir>/reviewers/<user>.json`. */
export const REVIEWERS_DIR = "reviewers";

/**
 * The reviewers file a user's terminals and runs get as GRAPH_EXECUTION_REVIEWERS: `<dataDir>/reviewers/<user>.json`
 * (each user has their own list), or the legacy `<dataDir>/reviewers.json` without a user.
 */
export const reviewersFilePath = (dataDir: string, userId?: string): string =>
  userId === undefined ? path.join(dataDir, REVIEWERS_JSON) : path.join(dataDir, REVIEWERS_DIR, `${userKeySegment(userId)}.json`);

/** Writes the reviewers file (of `userId`, or the legacy one) with the enabled reviewers: `<file>.tmp` with mode 600, then a rename. */
export async function writeReviewersFile(dataDir: string, reviewers: readonly Reviewer[], userId?: string): Promise<void> {
  const file = reviewersFilePath(dataDir, userId);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ reviewers: reviewers.filter((r) => r.enabled) }, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await renameReplacing(tmp, file);
}

/** Writes the user's own reviewers file from their store and returns its path (for a terminal's or run's env). */
export async function userReviewersFile(dataDir: string, user: User, us: UserStore): Promise<string> {
  await writeReviewersFile(dataDir, us.reviewers(), user.id);
  return reviewersFilePath(dataDir, user.id);
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
