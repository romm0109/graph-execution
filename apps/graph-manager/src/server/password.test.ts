import { existsSync } from "node:fs";
import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "./password.js";
import { tempDir } from "./test-helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempDir()));
afterEach(() => cleanup());

describe("resolvePassword", () => {
  it("generates a password and saves it in a file of mode 600", async () => {
    const file = path.join(dir, "password");
    const pw = await resolvePassword({}, dir);
    expect(pw).toEqual({ password: pw.password, source: "file", file, created: true });
    expect(pw.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await readFile(file, "utf8")).toBe(`${pw.password}\n`);
    expect(await readdir(dir)).toEqual(["password"]);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("tightens the mode of an existing file to 600", async () => {
    const file = path.join(dir, "password");
    await writeFile(file, "by-hand\n", { mode: 0o644 });
    await chmod(file, 0o644);
    expect(await resolvePassword({}, dir)).toEqual({ password: "by-hand", source: "file", file, created: false });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("gives every caller of a simultaneous first start a working password", async () => {
    const all = await Promise.all([resolvePassword({}, dir), resolvePassword({}, dir), resolvePassword({}, dir)]);
    const saved = (await readFile(path.join(dir, "password"), "utf8")).trim();
    expect(all.map((p) => p.password)).toContain(saved);
    expect(await readdir(dir)).toEqual(["password"]);
  });

  it("returns the saved password on the next call", async () => {
    const first = await resolvePassword({}, dir);
    const second = await resolvePassword({}, dir);
    expect(second).toEqual({ ...first, created: false });
  });

  it("creates a missing data dir", async () => {
    const pw = await resolvePassword({}, path.join(dir, "new"));
    expect(await readFile(path.join(dir, "new", "password"), "utf8")).toBe(`${pw.password}\n`);
  });

  it.each([["an empty", ""], ["a whitespace-only", " \n\t\n"]])("replaces %s file", async (_name, content) => {
    const file = path.join(dir, "password");
    await writeFile(file, content);
    const pw = await resolvePassword({}, dir);
    expect(pw.created).toBe(true);
    expect(pw.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await readFile(file, "utf8")).toBe(`${pw.password}\n`);
  });

  it("GM_PASSWORD wins and creates no file", async () => {
    const file = path.join(dir, "password");
    expect(await resolvePassword({ GM_PASSWORD: "pw" }, dir)).toEqual({ password: "pw", source: "env", file, created: false });
    expect(existsSync(file)).toBe(false);
  });

  it("GM_PASSWORD does not change an existing file", async () => {
    const file = path.join(dir, "password");
    await writeFile(file, "saved\n");
    expect((await resolvePassword({ GM_PASSWORD: "pw" }, dir)).password).toBe("pw");
    expect(await readFile(file, "utf8")).toBe("saved\n");
    expect(await resolvePassword({}, dir)).toMatchObject({ password: "saved", source: "file", created: false });
  });

  it("a whitespace-only GM_PASSWORD counts as unset", async () => {
    const pw = await resolvePassword({ GM_PASSWORD: "  " }, dir);
    expect(pw).toMatchObject({ source: "file", created: true });
    expect(pw.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});
