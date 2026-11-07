import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renameReplacing } from "./rename.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "graph-execution-rename-"));
});
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe("renameReplacing", () => {
  it("replaces the target", async () => {
    await writeFile(path.join(dir, "a.tmp"), "new");
    await writeFile(path.join(dir, "a"), "old");
    await renameReplacing(path.join(dir, "a.tmp"), path.join(dir, "a"));
    expect(await readFile(path.join(dir, "a"), "utf8")).toBe("new");
  });

  it("does not retry errors other than a locked target", async () => {
    const started = Date.now();
    await expect(renameReplacing(path.join(dir, "missing"), path.join(dir, "a"), "win32")).rejects.toMatchObject({ code: "ENOENT" });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
