// Blob storage (docs/prd/hosted-sessions.md): run archives outlive the clone or container they ran in.
// Files under `<dataDir>/blobs/` by default; S3 when `GM_BLOB_URL=s3://bucket/prefix` (the SDK is optional).
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { renameReplacing } from "graph-execution/api";
import { ConfigError, type Config } from "./config.js";

export interface BlobStore {
  put(key: string, data: Readable | Buffer): Promise<void>;
  get(key: string): Promise<Readable | undefined>;
  delete(key: string): Promise<void>;
  /** Removes every blob whose key starts with `prefix` (e.g. `runs/<userId>/`). */
  deletePrefix(prefix: string): Promise<void>;
}

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

const safeSegment = (s: string): boolean => SEGMENT.test(s) && s !== "." && s !== "..";

/**
 * The key or file-name segment of a user id. Built-in ids are already safe and stay as they are; a gateway `sub` may
 * hold any character (`auth0|abc`, an email), so such an id (or one starting with `~`, to keep the two forms apart)
 * becomes `~<base64url of the id>`.
 */
export function userKeySegment(userId: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(userId) && userId !== "." && userId !== "..") return userId;
  return `~${Buffer.from(userId, "utf8").toString("base64url")}`;
}

/** `key` when every `/`-separated segment is a safe id (not `.` or `..`); throws `invalid blob key: <key>` otherwise. */
export function checkKey(key: string): string {
  if (!key.split("/").every(safeSegment)) throw new Error(`invalid blob key: ${key}`);
  return key;
}

/** A prefix: a key, optionally ending in `/`. */
function checkPrefix(prefix: string): { dir: string[]; rest: string | undefined } {
  const trailing = prefix.endsWith("/");
  const body = trailing ? prefix.slice(0, -1) : prefix;
  if (body === "") throw new Error(`invalid blob key: ${prefix}`);
  checkKey(body);
  const parts = body.split("/");
  return trailing ? { dir: parts, rest: undefined } : { dir: parts.slice(0, -1), rest: parts[parts.length - 1] };
}

async function toBuffer(data: Readable | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return data;
  const chunks: Buffer[] = [];
  for await (const chunk of data) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

/** Blobs as files under `root` (mode 600, folders 700). */
export class FolderBlobStore implements BlobStore {
  constructor(readonly root: string) {}

  private fileOf(key: string): string {
    return path.join(this.root, ...checkKey(key).split("/"));
  }

  async put(key: string, data: Readable | Buffer): Promise<void> {
    const file = this.fileOf(key);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      if (Buffer.isBuffer(data)) await writeFile(tmp, data, { mode: 0o600 });
      else await pipeline(data, createWriteStream(tmp, { mode: 0o600 }));
      await chmod(tmp, 0o600);
      await renameReplacing(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async get(key: string): Promise<Readable | undefined> {
    const file = this.fileOf(key);
    try {
      const st = await stat(file);
      if (!st.isFile()) return undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    return createReadStream(file);
  }

  async delete(key: string): Promise<void> {
    await rm(this.fileOf(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    const { dir, rest } = checkPrefix(prefix);
    const folder = path.join(this.root, ...dir);
    if (rest === undefined) {
      await rm(folder, { recursive: true, force: true });
      return;
    }
    let names: string[];
    try {
      names = await readdir(folder);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    await Promise.all(names.filter((n) => n.startsWith(rest)).map((n) => rm(path.join(folder, n), { recursive: true, force: true })));
  }
}

/** The few S3 calls the store needs; `s3ApiFromSdk` builds it from `@aws-sdk/client-s3`, tests pass a fake. */
export interface S3Api {
  putObject(p: { Bucket: string; Key: string; Body: Buffer }): Promise<void>;
  /** undefined on NoSuchKey / 404. */
  getObject(p: { Bucket: string; Key: string }): Promise<Readable | undefined>;
  deleteObject(p: { Bucket: string; Key: string }): Promise<void>;
  listKeys(p: { Bucket: string; Prefix: string }): Promise<string[]>;
}

/** Blobs as objects `<prefix>/<key>` of an S3 bucket. */
export class S3BlobStore implements BlobStore {
  private readonly prefix: string;

  constructor(
    private readonly api: S3Api,
    private readonly bucket: string,
    prefix: string,
  ) {
    this.prefix = prefix.replace(/^\/+|\/+$/g, "");
  }

  private objectKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  async put(key: string, data: Readable | Buffer): Promise<void> {
    await this.api.putObject({ Bucket: this.bucket, Key: this.objectKey(checkKey(key)), Body: await toBuffer(data) });
  }

  get(key: string): Promise<Readable | undefined> {
    return this.api.getObject({ Bucket: this.bucket, Key: this.objectKey(checkKey(key)) });
  }

  async delete(key: string): Promise<void> {
    await this.api.deleteObject({ Bucket: this.bucket, Key: this.objectKey(checkKey(key)) });
  }

  async deletePrefix(prefix: string): Promise<void> {
    checkPrefix(prefix);
    const keys = await this.api.listKeys({ Bucket: this.bucket, Prefix: this.objectKey(prefix) });
    for (const Key of keys) await this.api.deleteObject({ Bucket: this.bucket, Key });
  }
}

// The SDK is not a dependency (users of GM_BLOB_URL install it): loaded by name, typed by what we use.
const S3_SDK = "@aws-sdk/client-s3";

type Command = new (input: Record<string, unknown>) => unknown;
interface S3Sdk {
  S3Client: new (config: Record<string, unknown>) => { send(command: unknown): Promise<unknown> };
  PutObjectCommand: Command;
  GetObjectCommand: Command;
  DeleteObjectCommand: Command;
  ListObjectsV2Command: Command;
}

/** An `S3Api` over `@aws-sdk/client-s3`; credentials come from the standard AWS environment variables. */
export async function s3ApiFromSdk(env: NodeJS.ProcessEnv): Promise<S3Api> {
  let sdk: S3Sdk;
  try {
    sdk = (await import(S3_SDK)) as S3Sdk;
  } catch {
    throw new ConfigError("GM_BLOB_URL needs @aws-sdk/client-s3: npm install @aws-sdk/client-s3");
  }
  const client = new sdk.S3Client({
    region: env.AWS_REGION,
    ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL, forcePathStyle: true } : {}),
  });
  return {
    async putObject(p) {
      await client.send(new sdk.PutObjectCommand(p));
    },
    async getObject(p) {
      try {
        const out = (await client.send(new sdk.GetObjectCommand(p))) as { Body?: Readable };
        return out.Body;
      } catch (err) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return undefined;
        throw err;
      }
    },
    async deleteObject(p) {
      await client.send(new sdk.DeleteObjectCommand(p));
    },
    async listKeys(p) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const out = (await client.send(new sdk.ListObjectsV2Command({ ...p, ...(token ? { ContinuationToken: token } : {}) }))) as {
          Contents?: { Key?: string }[];
          IsTruncated?: boolean;
          NextContinuationToken?: string;
        };
        for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key);
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
  };
}

/** The blob store of the config: `<dataDir>/blobs/`, or S3 with `blobUrl` (`s3://bucket/prefix`). */
export async function openBlobStore(config: Pick<Config, "dataDir" | "blobUrl">, env: NodeJS.ProcessEnv = process.env): Promise<BlobStore> {
  if (!config.blobUrl) return new FolderBlobStore(path.join(config.dataDir, "blobs"));
  const rest = config.blobUrl.slice("s3://".length);
  const slash = rest.indexOf("/");
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  const prefix = slash === -1 ? "" : rest.slice(slash + 1).replace(/^\/+|\/+$/g, "");
  if (!bucket) throw new ConfigError("invalid GM_BLOB_URL: no bucket");
  return new S3BlobStore(await s3ApiFromSdk(env), bucket, prefix);
}

/** A stream's bytes (archives are read whole). */
export function readAll(data: Readable): Promise<Buffer> {
  return toBuffer(data);
}
