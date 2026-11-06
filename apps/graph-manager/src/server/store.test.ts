import { stat, writeFile } from "node:fs/promises";
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

  it("throws on an invalid file", async () => {
    await writeFile(path.join(dir, DATA_FILE), JSON.stringify({ forges: {} }));
    await expect(DataStore.open(dir)).rejects.toThrow(/invalid/);
    await writeFile(path.join(dir, DATA_FILE), "{not json");
    await expect(DataStore.open(dir)).rejects.toThrow(/not valid JSON/);
  });
});
