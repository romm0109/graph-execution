import { readFile, stat, writeFile } from "node:fs/promises";
import { BUILTIN_REVIEWERS } from "graph-execution/api";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_FILE, DataStore } from "./store.js";
import { tempDir } from "./test-helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempDir()));
afterEach(() => cleanup());

describe("DataStore", () => {
  it("creates the file with a session secret and mode 600", async () => {
    const store = await DataStore.open(dir);
    expect(store.get().sessionSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(store.get().forges).toEqual({});
    expect(store.get().prs).toEqual({});
    const s = await stat(path.join(dir, DATA_FILE));
    if (process.platform !== "win32") expect(s.mode & 0o777).toBe(0o600);
  });

  it("seeds the built-in reviewers into a file without them and writes it", async () => {
    await writeFile(path.join(dir, DATA_FILE), JSON.stringify({ sessionSecret: "s" }));
    const store = await DataStore.open(dir);
    expect(store.reviewers()).toEqual(BUILTIN_REVIEWERS);
    const saved = JSON.parse(await readFile(path.join(dir, DATA_FILE), "utf8")) as { reviewers?: unknown };
    expect(saved.reviewers).toEqual(BUILTIN_REVIEWERS);
    expect((await DataStore.open(dir)).reviewers()).toEqual(BUILTIN_REVIEWERS);
  });

  it("persists updates and keeps the secret across opens", async () => {
    const store = await DataStore.open(dir);
    const secret = store.get().sessionSecret;
    await Promise.all([
      store.update((d) => {
        d.forges.github = { token: "t", login: "octo" };
      }),
      store.update((d) => {
        d.prs["ws/run"] = { url: "u", number: 1, branch: "b", forge: "github", createdAt: "2026-01-01" };
      }),
    ]);
    const again = await DataStore.open(dir);
    expect(again.get().sessionSecret).toBe(secret);
    expect(again.get().forges.github).toEqual({ token: "t", login: "octo" });
    expect(again.get().prs["ws/run"]?.number).toBe(1);
    if (process.platform !== "win32") expect((await stat(path.join(dir, DATA_FILE))).mode & 0o777).toBe(0o600);
  });

  it("rejects an update that breaks the schema and keeps the old data", async () => {
    const store = await DataStore.open(dir);
    await expect(
      store.update((d) => {
        (d as { sessionSecret: unknown }).sessionSecret = 5;
      }),
    ).rejects.toThrow();
    expect(typeof store.get().sessionSecret).toBe("string");
    await store.update((d) => {
      d.forges.github = { token: "t", login: "l" };
    });
    expect(store.get().forges.github?.login).toBe("l");
  });

  it("opens an old file without the sandbox keys with their defaults", async () => {
    await writeFile(path.join(dir, DATA_FILE), JSON.stringify({ sessionSecret: "s", forges: {}, prs: {}, revokedSessions: {} }));
    const store = await DataStore.open(dir);
    expect(store.get().sandboxes).toEqual({});
    expect(store.get().sandboxLimits).toEqual({ cpus: 2, memoryMb: 4096, pids: 2048 });
    expect(store.get().workspaceSettings).toEqual({});
    await store.update((d) => {
      d.sandboxes["ws/run"] = { runId: "run", workspace: "ws", container: "c", name: "n", host: "h", image: "i", port: 7600, startedAt: "2026-01-01" };
      d.workspaceSettings.ws = { image: "img", sandbox: true };
    });
    const again = await DataStore.open(dir);
    expect(again.get().sandboxes["ws/run"]?.host).toBe("h");
    expect(again.get().workspaceSettings.ws).toEqual({ image: "img", sandbox: true });
  });

  it("throws on an invalid file", async () => {
    await writeFile(path.join(dir, DATA_FILE), JSON.stringify({ forges: {} }));
    await expect(DataStore.open(dir)).rejects.toThrow(/invalid/);
    await writeFile(path.join(dir, DATA_FILE), "{not json");
    await expect(DataStore.open(dir)).rejects.toThrow(/not valid JSON/);
  });
});
