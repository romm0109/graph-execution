import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";

export const gitOut = async (cwd: string, args: string[]): Promise<string> =>
  (await execa("git", args, { cwd })).stdout.trim();

/** A temp git repo on branch `main` with a local identity and one commit. */
export async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "graph-execution-repo-"));
  await execa("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await execa("git", ["config", "user.name", "Test"], { cwd: dir });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execa("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# test\n");
  await execa("git", ["add", "-A"], { cwd: dir });
  await execa("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}
