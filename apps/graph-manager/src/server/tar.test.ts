import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gzipTar, readTar, readTarGz, tarArchive, type TarEntry } from "./tar.js";
import { tempDir } from "./test-helpers.js";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await cleanup();
});

const owner = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

describe("tarArchive", () => {
  it("writes an archive that tar lists and extracts", async () => {
    const long = `${"a".repeat(60)}/${"b".repeat(60)}/c.txt`;
    expect(long.length).toBeGreaterThan(100);
    const archive = tarArchive(
      [
        { path: "dir/", dir: true, mode: 0o700 },
        { path: "dir/one.txt", content: Buffer.from("hello\n"), mode: 0o600 },
        { path: "big.bin", content: Buffer.alloc(1000, 7) },
        { path: long, content: Buffer.from("deep") },
      ],
      owner,
    );
    expect(archive.length % 512).toBe(0);
    const file = path.join(dir, "a.tar");
    await writeFile(file, archive);
    const list = (await execa("tar", ["-tvf", file])).stdout.split(/\r?\n/);
    expect(list).toHaveLength(4);
    expect(list[0]).toMatch(/^d.*\sdir\/$/);
    expect(list[1]).toMatch(/\s6\s.*dir\/one\.txt$/);
    expect(list[2]).toMatch(/\s1000\s.*big\.bin$/);
    expect(list[3]).toMatch(new RegExp(`${long.replace(/\./g, "\\.")}$`));
    const out = path.join(dir, "out");
    await mkdir(out);
    await execa("tar", ["-xf", file, "-C", out]);
    expect(await readFile(path.join(out, "dir", "one.txt"), "utf8")).toBe("hello\n");
    expect(await readFile(path.join(out, "big.bin"))).toEqual(Buffer.alloc(1000, 7));
    expect(await readFile(path.join(out, long), "utf8")).toBe("deep");
  });
});

describe("readTar", () => {
  it("round-trips what tarArchive writes, including a 150-byte path", () => {
    const long = `${"a".repeat(70)}/${"b".repeat(70)}/c.txt...`;
    expect(Buffer.byteLength(long)).toBe(150);
    const entries: TarEntry[] = [
      { path: "dir/", dir: true, mode: 0o700 },
      { path: "dir/one.txt", content: Buffer.from("hello\n"), mode: 0o600 },
      { path: "empty.txt", content: Buffer.alloc(0), mode: 0o644 },
      { path: "big.bin", content: Buffer.alloc(1000, 7), mode: 0o644 },
      { path: long, content: Buffer.from("deep"), mode: 0o644 },
    ];
    expect(readTar(tarArchive(entries, owner))).toEqual(entries);
    expect(readTarGz(gzipTar(entries, owner))).toEqual(entries);
  });

  it("throws on a truncated archive", () => {
    const archive = tarArchive([{ path: "a.bin", content: Buffer.alloc(2000, 1) }], owner);
    expect(() => readTar(archive.subarray(0, 1024))).toThrow("tar: truncated archive");
  });

  it("writes a .tar.gz that tar lists", async () => {
    const file = path.join(dir, "a.tar.gz");
    await writeFile(file, gzipTar([{ path: "logs/", dir: true }, { path: "logs/x.log", content: Buffer.from("x") }], owner));
    const list = (await execa("tar", ["-tzf", file])).stdout.split(/\r?\n/);
    expect(list).toEqual(["logs/", "logs/x.log"]);
  });
});
