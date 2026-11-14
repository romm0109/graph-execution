// The files a session's Push never stages. The rule itself lives in host/local.ts (`isSecretPath`): the agent's save
// uses it too, so there is exactly one.
import { isSecretPath } from "../host/local.js";

export { isSecretPath };

/**
 * The paths of `git status --porcelain=v1 -z --untracked-files=all`: entries `XY path\0`; a rename or copy (`R`/`C`)
 * is followed by its old path as the next NUL field, which is skipped.
 */
export function parsePorcelainZ(out: string): string[] {
  const fields = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (xy.includes("R") || xy.includes("C")) i++;
  }
  return paths;
}

/** Splits changed paths into the ones to stage and the secrets to leave out. */
export function selectSaveFiles(paths: string[]): { add: string[]; skipped: string[] } {
  const add: string[] = [];
  const skipped: string[] = [];
  for (const p of paths) (isSecretPath(p) ? skipped : add).push(p);
  return { add, skipped };
}
