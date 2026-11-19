import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { escalationRecordSchema } from "./schema.js";
import { inboxPath, loadEscalations, nextEscalationId, openEscalations, readInbox, saveEscalation } from "./store.js";

let runDir: string;
beforeEach(async () => {
  runDir = await mkdtemp(path.join(os.tmpdir(), "escalation-store-"));
});
afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

const file = { reason: "r", evidence: "e", questions: [{ id: "q1", question: "A or B?" }] };
const record = (node: string) => ({
  ...file,
  source: "agent" as const,
  node,
  attempt: 1,
  createdAt: new Date().toISOString(),
  status: "open" as const,
});

async function write(name: string, text: string): Promise<string> {
  const f = inboxPath(runDir, name, 1);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, text);
  return f;
}

describe("escalation store", () => {
  it("puts the inbox under <runDir>/escalations/inbox with a sanitized label", () => {
    expect(inboxPath(runDir, "a b/c", 2)).toBe(path.join(runDir, "escalations", "inbox", "a-b-c-a2.json"));
  });

  it("reads a missing inbox file as none", async () => {
    expect(await readInbox(inboxPath(runDir, "1", 1))).toEqual({ kind: "none" });
  });

  it("reads bad JSON, a wrong shape and duplicate question ids as invalid", async () => {
    expect((await readInbox(await write("a", "not json"))).kind).toBe("invalid");
    const empty = await readInbox(await write("b", "{}"));
    expect(empty.kind).toBe("invalid");
    expect(empty.kind === "invalid" && empty.message).toContain("reason");
    const dup = await readInbox(
      await write("c", JSON.stringify({ ...file, questions: [{ id: "q1", question: "x" }, { id: "q1", question: "y" }] })),
    );
    expect(dup.kind === "invalid" && dup.message).toContain("duplicate question id q1");
    expect((await readInbox(await write("d", JSON.stringify({ ...file, questions: [] })))).kind).toBe("invalid");
  });

  it("reads a valid file, raw or in a Markdown fence", async () => {
    expect(await readInbox(await write("a", JSON.stringify(file)))).toEqual({ kind: "valid", file });
    expect(await readInbox(await write("b", "```json\n" + JSON.stringify(file) + "\n```\n"))).toEqual({ kind: "valid", file });
  });

  it("allocates E1, E2, … even when two escalations are saved at once", async () => {
    expect(await nextEscalationId(runDir)).toBe("E1");
    const saved = await Promise.all([saveEscalation(runDir, record("2")), saveEscalation(runDir, record("3"))]);
    expect(saved.map((r) => r.id).sort()).toEqual(["E1", "E2"]);
    const third = await saveEscalation(runDir, record("4"));
    expect(third.id).toBe("E3");
    const loaded = await loadEscalations(runDir);
    expect(loaded.map((r) => r.id)).toEqual(["E1", "E2", "E3"]);
    escalationRecordSchema.parse(JSON.parse(await readFile(path.join(runDir, "escalations", "E1.json"), "utf8")));

    await saveEscalation(runDir, { ...third, status: "resolved", resolvedAt: new Date().toISOString() });
    expect((await openEscalations(runDir)).map((r) => r.id)).toEqual(["E1", "E2"]);
  });

  it("sorts E10 after E9", async () => {
    for (let i = 0; i < 10; i++) await saveEscalation(runDir, record(String(i)));
    expect((await loadEscalations(runDir)).map((r) => r.id).slice(-2)).toEqual(["E9", "E10"]);
    expect(await nextEscalationId(runDir)).toBe("E11");
  });
});
