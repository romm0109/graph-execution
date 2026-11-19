import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameReplacing } from "../fs/rename.js";
import { parseReportText } from "../review/report.js";
import { type EscalationFile, escalationFileSchema, type EscalationRecord, escalationRecordSchema } from "./schema.js";

/** `<runDir>/escalations`: one `E<n>.json` record per escalation, and the agents' `inbox/`. */
export const escalationsDir = (runDir: string): string => path.join(runDir, "escalations");

/** Where the agent labelled `label` writes its escalation during attempt `attempt`; outside every worktree. */
export const inboxPath = (runDir: string, label: string, attempt: number): string =>
  path.join(escalationsDir(runDir), "inbox", `${label.replace(/[^\w.-]+/g, "-")}-a${attempt}.json`);

export type InboxResult = { kind: "none" } | { kind: "invalid"; message: string } | { kind: "valid"; file: EscalationFile };

/** Reads an agent's escalation file: none written, written but not matching the schema, or valid. */
export async function readInbox(file: string): Promise<InboxResult> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    throw err;
  }
  let data: unknown;
  try {
    data = parseReportText(text);
  } catch (err) {
    return { kind: "invalid", message: err instanceof Error ? err.message : String(err) };
  }
  const parsed = escalationFileSchema.safeParse(data);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.length > 0 ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; ");
    return { kind: "invalid", message };
  }
  return { kind: "valid", file: parsed.data };
}

const recordNumber = (name: string): number | undefined => {
  const m = /^E(\d+)\.json$/.exec(name);
  return m ? Number(m[1]) : undefined;
};

async function recordFiles(runDir: string): Promise<{ n: number; name: string }[]> {
  let names: string[];
  try {
    names = await readdir(escalationsDir(runDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names
    .flatMap((name) => {
      const n = recordNumber(name);
      return n === undefined ? [] : [{ n, name }];
    })
    .sort((a, b) => a.n - b.n);
}

/** The next free id: `E1`, `E2`, … after the records already saved. */
export async function nextEscalationId(runDir: string): Promise<string> {
  const files = await recordFiles(runDir);
  return `E${(files.at(-1)?.n ?? 0) + 1}`;
}

async function writeRecord(runDir: string, record: EscalationRecord): Promise<void> {
  const dir = escalationsDir(runDir);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${record.id}.json`);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(escalationRecordSchema.parse(record), null, 2)}\n`);
  await renameReplacing(tmp, file);
}

/** Per run dir, the chain that serializes id allocation and writes, so two escalations never share an id. */
const chains = new Map<string, Promise<unknown>>();

function serialized<T>(runDir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(runDir);
  const next = (chains.get(key) ?? Promise.resolve()).then(fn);
  chains.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Saves a record atomically. A record without an `id` gets the next free one, allocated in the same serialized
 * section as the write; the saved record is returned.
 */
export function saveEscalation(
  runDir: string,
  record: EscalationRecord | (Omit<EscalationRecord, "id"> & { id?: undefined }),
): Promise<EscalationRecord> {
  return serialized(runDir, async () => {
    const full: EscalationRecord = { ...record, id: record.id ?? (await nextEscalationId(runDir)) };
    await writeRecord(runDir, full);
    return full;
  });
}

/** Every saved escalation, in id order. */
export async function loadEscalations(runDir: string): Promise<EscalationRecord[]> {
  const records: EscalationRecord[] = [];
  for (const { name } of await recordFiles(runDir)) {
    const text = await readFile(path.join(escalationsDir(runDir), name), "utf8");
    records.push(escalationRecordSchema.parse(JSON.parse(text)));
  }
  return records;
}

/** The escalations still waiting for a resolution. */
export async function openEscalations(runDir: string): Promise<EscalationRecord[]> {
  return (await loadEscalations(runDir)).filter((r) => r.status === "open");
}

/** Removes an agent's inbox file once it was read. */
export async function removeInbox(file: string): Promise<void> {
  await rm(file, { force: true });
}
