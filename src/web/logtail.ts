import { type FSWatcher, existsSync, statSync, watch } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export const TAIL_BYTES = 8 * 1024;
export const FULL_BYTES = 5 * 1024 * 1024;
export const MAX_WATCHED = 16;
const POLL_MS = 1000;
const LABEL = /^[\w.-]+$/;

export interface LogInfo {
  label: string;
  size: number;
  tail: string;
  /** Last modification, ms since the epoch. */
  mtime: number;
}

export const validLabel = (label: string): boolean => LABEL.test(label);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Log labels (file names without .log) that belong to a run-page node. Kept identical to `labelsForNode` in assets/logs.js. */
export function labelsForNode(nodeId: string, labels: string[]): string[] {
  const own: RegExp | undefined = {
    "@reviewer": /^code-r\d+$/,
    "@tester": /^tester-r\d+$/,
    "@fixer": /^fix-r\d+(-v\d+)?$/,
    "@gate-fixer": /^fix-r\d+-v\d+$/,
  }[nodeId];
  const task = nodeId.startsWith("@") ? undefined : new RegExp(`^${escapeRe(nodeId)}(-validate-\\d+)?$`);
  const summary = `summary-${nodeId.replace(/[^\w.-]+/g, "-")}`;
  return labels.filter((l) => (own ?? task)?.test(l) === true || l === summary);
}

/** Where a new watch starts: the size the client already holds, if that is a valid position, else the current size. */
function startOffset(known: unknown, size: number): number {
  return typeof known === "number" && Number.isInteger(known) && known >= 0 && known <= size ? known : size;
}

async function readRange(file: string, start: number, end: number): Promise<Buffer> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

interface Watched {
  refs: number;
  offset: number;
  decoder: StringDecoder;
  reading: boolean;
}

/** Reads and tails the `*.log` files of one directory. */
export class LogTail {
  private readonly watched = new Map<string, Watched>();
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly dir: string,
    private readonly onChunk: (label: string, offset: number, text: string) => void,
  ) {}

  private file(label: string): string {
    return path.join(this.dir, `${label}.log`);
  }

  async list(keep: (label: string) => boolean = () => true): Promise<LogInfo[]> {
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => f.endsWith(".log")).map((f) => f.slice(0, -4)).sort().map((l) => `${l}.log`);
    const out: LogInfo[] = [];
    for (const name of names) {
      const label = name.slice(0, -4);
      if (!validLabel(label) || !keep(label)) continue;
      try {
        const file = path.join(this.dir, name);
        const st = await stat(file);
        if (!st.isFile()) continue;
        const start = Math.max(0, st.size - TAIL_BYTES);
        let buf = await readRange(file, start, st.size);
        // A byte cut can land inside a multi-byte character: drop its continuation bytes.
        if (start > 0) {
          let i = 0;
          while (i < buf.length && i < 3 && (buf[i]! & 0xc0) === 0x80) i++;
          buf = buf.subarray(i);
        }
        out.push({ label, size: st.size, tail: buf.toString("utf8"), mtime: st.mtimeMs });
      } catch {
        // the file vanished
      }
    }
    return out;
  }

  /** The last 5 MB of a log; `size` is the file size the text ends at. */
  async full(label: string): Promise<{ label: string; text: string; truncated: boolean; size: number }> {
    if (!validLabel(label)) throw new Error(`invalid log label: ${label}`);
    const file = this.file(label);
    const size = (await stat(file)).size;
    const start = Math.max(0, size - FULL_BYTES);
    return { label, text: (await readRange(file, start, size)).toString("utf8"), truncated: start > 0, size };
  }

  /** Starts reading appended text of these logs. Throws on an invalid or unknown label, or past 16 watched logs. */
  subscribe(labels: string[], offsets: Record<string, number> = {}): () => void {
    for (const l of labels) {
      if (!validLabel(l)) throw new Error(`invalid log label: ${l}`);
      if (!existsSync(this.file(l))) throw new Error(`unknown log: ${l}`);
    }
    const unique = [...new Set(labels)];
    const added = unique.filter((l) => !this.watched.has(l)).length;
    if (this.watched.size + added > MAX_WATCHED) throw new Error(`at most ${MAX_WATCHED} logs can be watched`);
    for (const l of unique) {
      const w = this.watched.get(l);
      if (w) w.refs++;
      else this.watched.set(l, { refs: 1, offset: startOffset(offsets[l], statSync(this.file(l)).size), decoder: new StringDecoder("utf8"), reading: false });
    }
    this.start();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      for (const l of unique) {
        const w = this.watched.get(l);
        if (w && --w.refs <= 0) this.watched.delete(l);
      }
      if (this.watched.size === 0) this.stop();
    };
  }

  private start(): void {
    if (this.closed || this.timer) return;
    try {
      this.watcher = watch(this.dir, () => this.poll());
      this.watcher.on("error", () => this.watcher?.close());
    } catch {
      // the 1 s poll covers it
    }
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  private stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private poll(): void {
    for (const [label, w] of this.watched) void this.read(label, w);
  }

  private async read(label: string, w: Watched): Promise<void> {
    if (w.reading) return;
    w.reading = true;
    try {
      const size = (await stat(this.file(label))).size;
      if (size < w.offset) {
        w.offset = 0;
        w.decoder = new StringDecoder("utf8");
      }
      if (size === w.offset) return;
      const start = w.offset;
      const buf = await readRange(this.file(label), start, size);
      w.offset = start + buf.length;
      const text = w.decoder.write(buf);
      if (text !== "" && this.watched.get(label) === w) this.onChunk(label, start, text);
    } catch {
      // the file vanished; the next tick retries
    } finally {
      w.reading = false;
    }
  }

  close(): void {
    this.closed = true;
    this.watched.clear();
    this.stop();
  }
}
