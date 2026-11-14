import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkKey, FolderBlobStore, openBlobStore, readAll, S3BlobStore, type S3Api } from "./blobs.js";
import { tempDir } from "./test-helpers.js";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await cleanup();
});

const text = async (r: Readable | undefined): Promise<string | undefined> => (r ? (await readAll(r)).toString("utf8") : undefined);

describe("checkKey", () => {
  it("accepts safe segments and rejects anything that could escape", () => {
    expect(checkKey("runs/u1/github~o~r/gm-1.tar.gz")).toBe("runs/u1/github~o~r/gm-1.tar.gz");
    for (const bad of ["../x", "a//b", "/a", "a/./b", "a/", "", "a b", "a\\b"]) expect(() => checkKey(bad)).toThrow(`invalid blob key: ${bad}`);
  });
});

describe("FolderBlobStore", () => {
  it("round-trips a Buffer and a Readable, in private files", async () => {
    const blobs = new FolderBlobStore(path.join(dir, "blobs"));
    await blobs.put("runs/u1/ws/a.bin", Buffer.from("buffer"));
    await blobs.put("runs/u1/ws/b.bin", Readable.from([Buffer.from("str"), Buffer.from("eam")]));
    expect(await text(await blobs.get("runs/u1/ws/a.bin"))).toBe("buffer");
    expect(await text(await blobs.get("runs/u1/ws/b.bin"))).toBe("stream");
    await blobs.put("runs/u1/ws/a.bin", Buffer.from("replaced"));
    expect(await text(await blobs.get("runs/u1/ws/a.bin"))).toBe("replaced");
    if (process.platform !== "win32") {
      for (const f of ["a.bin", "b.bin"]) expect((await stat(path.join(dir, "blobs", "runs", "u1", "ws", f))).mode & 0o777).toBe(0o600);
    }
    // No temp files left behind.
    expect((await readdir(path.join(dir, "blobs", "runs", "u1", "ws"))).sort()).toEqual(["a.bin", "b.bin"]);
  });

  it("gets undefined for a missing key, deletes, and deletes by prefix", async () => {
    const blobs = new FolderBlobStore(path.join(dir, "blobs"));
    expect(await blobs.get("runs/none")).toBeUndefined();
    await blobs.put("x", Buffer.from("x"));
    await blobs.delete("x");
    expect(await blobs.get("x")).toBeUndefined();
    await blobs.delete("x");
    await blobs.put("runs/u1/ws/r1.tar.gz", Buffer.from("1"));
    await blobs.put("runs/u1/ws/r2.tar.gz", Buffer.from("2"));
    await blobs.put("runs/u2/ws/r1.tar.gz", Buffer.from("3"));
    await blobs.put("runs/u10/ws/r1.tar.gz", Buffer.from("4"));
    await blobs.deletePrefix("runs/u1/ws/r1");
    expect(await blobs.get("runs/u1/ws/r1.tar.gz")).toBeUndefined();
    expect(await text(await blobs.get("runs/u1/ws/r2.tar.gz"))).toBe("2");
    await blobs.deletePrefix("runs/u1/");
    expect(existsSync(path.join(dir, "blobs", "runs", "u1"))).toBe(false);
    expect(await text(await blobs.get("runs/u2/ws/r1.tar.gz"))).toBe("3");
    expect(await text(await blobs.get("runs/u10/ws/r1.tar.gz"))).toBe("4");
    await blobs.deletePrefix("runs/nobody/");
    await expect(blobs.deletePrefix("../")).rejects.toThrow("invalid blob key");
  });
});

function fakeS3(): S3Api & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async putObject(p) {
      objects.set(`${p.Bucket}:${p.Key}`, p.Body);
    },
    async getObject(p) {
      const b = objects.get(`${p.Bucket}:${p.Key}`);
      return b ? Readable.from([b]) : undefined;
    },
    async deleteObject(p) {
      objects.delete(`${p.Bucket}:${p.Key}`);
    },
    async listKeys(p) {
      return [...objects.keys()].filter((k) => k.startsWith(`${p.Bucket}:${p.Prefix}`)).map((k) => k.slice(p.Bucket.length + 1));
    },
  };
}

describe("S3BlobStore", () => {
  it("puts, gets, deletes and deletes by prefix under the bucket's prefix", async () => {
    const api = fakeS3();
    const blobs = new S3BlobStore(api, "b", "/p/");
    await blobs.put("runs/u1/ws/r1.tar.gz", Readable.from([Buffer.from("one")]));
    await blobs.put("runs/u2/ws/r1.tar.gz", Buffer.from("two"));
    expect([...api.objects.keys()].sort()).toEqual(["b:p/runs/u1/ws/r1.tar.gz", "b:p/runs/u2/ws/r1.tar.gz"]);
    expect(await text(await blobs.get("runs/u1/ws/r1.tar.gz"))).toBe("one");
    expect(await blobs.get("runs/u3/x")).toBeUndefined();
    await blobs.deletePrefix("runs/u1/");
    expect([...api.objects.keys()]).toEqual(["b:p/runs/u2/ws/r1.tar.gz"]);
    await blobs.delete("runs/u2/ws/r1.tar.gz");
    expect(api.objects.size).toBe(0);
    await expect(blobs.put("../x", Buffer.alloc(0))).rejects.toThrow("invalid blob key: ../x");
  });

  it("uses the key itself without a prefix", async () => {
    const api = fakeS3();
    await new S3BlobStore(api, "b", "").put("k", Buffer.from("v"));
    expect([...api.objects.keys()]).toEqual(["b:k"]);
  });
});

function sdkInstalled(): boolean {
  try {
    import.meta.resolve("@aws-sdk/client-s3");
    return true;
  } catch {
    return false;
  }
}

describe("openBlobStore", () => {
  it("uses <dataDir>/blobs without a blob URL", async () => {
    const blobs = await openBlobStore({ dataDir: dir });
    expect(blobs).toBeInstanceOf(FolderBlobStore);
    expect((blobs as FolderBlobStore).root).toBe(path.join(dir, "blobs"));
  });

  it.skipIf(sdkInstalled())("stops with an install hint when the S3 SDK is missing", async () => {
    await expect(openBlobStore({ dataDir: dir, blobUrl: "s3://b/p" })).rejects.toThrow(
      /^GM_BLOB_URL needs @aws-sdk\/client-s3: npm install @aws-sdk\/client-s3$/,
    );
  });
});
