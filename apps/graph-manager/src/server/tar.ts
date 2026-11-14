// A minimal POSIX ustar writer (KAN-88): enough to put a few login files into a container with `putArchive`.
// Plus a reader of what it writes (the run archive keeps run folders as .tar.gz blobs).
import { gunzipSync, gzipSync } from "node:zlib";

export interface TarEntry {
  /** Relative path with "/" separators; a directory may end with "/". */
  path: string;
  dir?: boolean;
  content?: Buffer;
  mode?: number;
}

const BLOCK = 512;

function writeString(buf: Buffer, value: string, offset: number, length: number): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`tar: "${value}" does not fit in ${length} bytes`);
  bytes.copy(buf, offset);
}

/** `value` as zero-padded octal of `length - 1` digits plus a trailing NUL. */
function writeOctal(buf: Buffer, value: number, offset: number, length: number): void {
  const digits = Math.floor(value).toString(8);
  if (digits.length > length - 1) throw new Error(`tar: ${value} does not fit in ${length} bytes`);
  writeString(buf, digits.padStart(length - 1, "0"), offset, length - 1);
  buf[offset + length - 1] = 0;
}

/** Splits a path into ustar `prefix` (≤155 bytes) and `name` (≤100 bytes). */
function splitName(p: string): { prefix: string; name: string } {
  if (Buffer.byteLength(p) <= 100) return { prefix: "", name: p };
  // Split at a "/" so that the name part fits in 100 bytes and the prefix in 155 (a trailing "/" of a dir stays in the name).
  for (let i = p.length - 1; i > 0; i--) {
    if (p[i] !== "/" || i === p.length - 1) continue;
    const prefix = p.slice(0, i);
    const name = p.slice(i + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { prefix, name };
    if (Buffer.byteLength(name) > 100) break;
  }
  throw new Error(`tar: path too long: ${p}`);
}

function header(entry: TarEntry, owner: { uid: number; gid: number }, size: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  const p = entry.dir && !entry.path.endsWith("/") ? `${entry.path}/` : entry.path;
  const { prefix, name } = splitName(p);
  writeString(h, name, 0, 100);
  writeOctal(h, entry.mode ?? (entry.dir ? 0o755 : 0o644), 100, 8);
  writeOctal(h, owner.uid, 108, 8);
  writeOctal(h, owner.gid, 116, 8);
  writeOctal(h, size, 124, 12);
  writeOctal(h, Math.floor(Date.now() / 1000), 136, 12);
  h.fill(0x20, 148, 156); // the checksum field counts as spaces
  h[156] = (entry.dir ? "5" : "0").charCodeAt(0);
  writeString(h, "ustar\0", 257, 6);
  writeString(h, "00", 263, 2);
  writeString(h, prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  writeString(h, sum.toString(8).padStart(6, "0"), 148, 6);
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

/** A tar archive of `entries`, every one owned by `owner`. */
export function tarArchive(entries: TarEntry[], owner: { uid: number; gid: number }): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const content = e.dir ? Buffer.alloc(0) : (e.content ?? Buffer.alloc(0));
    parts.push(header(e, owner, content.length));
    if (content.length > 0) {
      parts.push(content);
      const pad = (BLOCK - (content.length % BLOCK)) % BLOCK;
      if (pad > 0) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** A NUL-terminated string field. */
function readString(buf: Buffer, offset: number, length: number): string {
  const field = buf.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function readOctal(buf: Buffer, offset: number, length: number): number {
  const text = readString(buf, offset, length).trim();
  return text === "" ? 0 : parseInt(text, 8);
}

/**
 * The files and directories of a ustar archive as `tarArchive` writes it. Other entry types (links, …) are skipped.
 * Stops at the first all-zero block; throws `tar: truncated archive` when an entry runs past the buffer.
 */
export function readTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const name = readString(h, 0, 100);
    const prefix = readString(h, 345, 155);
    const p = prefix ? `${prefix}/${name}` : name;
    const mode = readOctal(h, 100, 8);
    const size = readOctal(h, 124, 12);
    const type = String.fromCharCode(h[156] ?? 0);
    off += BLOCK;
    if (off + size > buf.length) throw new Error("tar: truncated archive");
    const content = Buffer.from(buf.subarray(off, off + size));
    off += size + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (type === "5") entries.push({ path: p, dir: true, mode });
    else if (type === "0" || type === "\0") entries.push({ path: p, content, mode });
  }
  return entries;
}

/** `tarArchive`, gzipped. */
export function gzipTar(entries: TarEntry[], owner: { uid: number; gid: number }): Buffer {
  return gzipSync(tarArchive(entries, owner));
}

/** `readTar` of a gzipped archive. */
export function readTarGz(buf: Buffer): TarEntry[] {
  return readTar(gunzipSync(buf));
}
