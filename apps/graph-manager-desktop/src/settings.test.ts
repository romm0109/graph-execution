import { mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSettings, writeSettings } from "./settings.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "gmd-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, "desktop.json");

describe("readSettings", () => {
  it("returns {} when the file is missing", () => {
    expect(readSettings(dir)).toEqual({});
  });

  it("returns {} for invalid JSON", async () => {
    await writeFile(file(), "{not json");
    expect(readSettings(dir)).toEqual({});
  });

  it("drops a mode that is not local or remote", async () => {
    await writeFile(file(), JSON.stringify({ mode: "x" }));
    expect(readSettings(dir)).toEqual({});
  });

  it("drops fields of the wrong type and non-http URLs", async () => {
    await writeFile(file(), JSON.stringify({ mode: "remote", remoteUrl: "file:///etc", bounds: { x: "1" } }));
    expect(readSettings(dir)).toEqual({ mode: "remote" });
  });

  it("reads an old file with a localPassword key as the other fields only", async () => {
    await writeFile(file(), JSON.stringify({ mode: "local", localPassword: "secret" }));
    expect(readSettings(dir)).toEqual({ mode: "local" });
  });
});

describe("writeSettings", () => {
  it("round-trips a valid object", () => {
    const s = { mode: "remote" as const, remoteUrl: "https://gm.example.com/", bounds: { x: 1, y: 2, width: 300, height: 400 } };
    writeSettings(dir, s);
    expect(readSettings(dir)).toEqual(s);
  });

  it("creates the directory", async () => {
    const nested = path.join(dir, "a", "b");
    writeSettings(nested, { mode: "local" });
    expect(JSON.parse(await readFile(path.join(nested, "desktop.json"), "utf8"))).toEqual({ mode: "local" });
  });

  it.skipIf(process.platform === "win32")("writes the file with mode 0o600", async () => {
    writeSettings(dir, { mode: "local" });
    expect((await stat(file())).mode & 0o777).toBe(0o600);
  });
});
