import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPlanResult } from "./result.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "plan-result-"));
  file = path.join(dir, "result.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const refs = [{ ref: "KAN-41" }, { ref: "KAN-42", title: "Second" }];
async function read(result: unknown, withRefs = false) {
  await writeFile(file, typeof result === "string" ? result : JSON.stringify(result));
  return readPlanResult(file, withRefs ? refs : []);
}
const errorOf = (r: Awaited<ReturnType<typeof read>>): string => (r.ok ? "" : r.error);

describe("readPlanResult without refs", () => {
  it("reads a ready unit", async () => {
    expect(await read({ name: "my-plan", ready: true, questions: [] })).toEqual({
      ok: true,
      readiness: { nothingReady: false, name: "my-plan", dropped: [], questions: [] },
    });
  });

  it("reads a unit that is not ready", async () => {
    expect(await read({ ready: false, questions: ["Which DB?"] })).toEqual({
      ok: true,
      readiness: { nothingReady: true, dropped: [], questions: [{ questions: ["Which DB?"] }] },
    });
  });

  it("needs a name when ready and a question when not ready", async () => {
    expect(errorOf(await read({ ready: true }))).toContain("name is required when ready is true");
    expect(errorOf(await read({ ready: false, questions: [] }))).toContain("at least one question");
    expect(errorOf(await read({ name: "Bad Name", ready: true }))).toContain("kebab-case");
  });

  it("reports a missing file and invalid JSON", async () => {
    expect(errorOf(await readPlanResult(file, []))).toContain("wrote no result file");
    expect(errorOf(await read("{"))).toContain("is not valid JSON");
  });
});

describe("readPlanResult with refs", () => {
  it("reads ready and not-ready refs", async () => {
    const r = await read({ name: "p", ready: ["KAN-41"], notReady: [{ ref: "KAN-42", questions: ["Why?"] }] }, true);
    expect(r).toEqual({
      ok: true,
      readiness: { nothingReady: false, name: "p", dropped: ["KAN-42"], questions: [{ ref: "KAN-42", questions: ["Why?"] }] },
    });
  });

  it("reads nothing ready without a name", async () => {
    const notReady = [
      { ref: "KAN-41", questions: ["A?"] },
      { ref: "KAN-42", questions: ["B?"] },
    ];
    const r = await read({ ready: [], notReady }, true);
    expect(r.ok && r.readiness).toEqual({
      nothingReady: true,
      dropped: ["KAN-41", "KAN-42"],
      questions: [
        { ref: "KAN-41", questions: ["A?"] },
        { ref: "KAN-42", questions: ["B?"] },
      ],
    });
  });

  it("refuses missing, unknown and duplicate refs, and a missing name", async () => {
    expect(errorOf(await read({ name: "p", ready: ["KAN-41"] }, true))).toContain("ref KAN-42 is missing: put it in ready or notReady");
    expect(errorOf(await read({ name: "p", ready: ["KAN-41", "KAN-42", "KAN-9"] }, true))).toContain(
      "ref KAN-9 is not one of the run's refs (KAN-41, KAN-42)",
    );
    expect(errorOf(await read({ name: "p", ready: ["KAN-41", "KAN-42"], notReady: [{ ref: "KAN-41", questions: ["?"] }] }, true))).toContain(
      "ref KAN-41 is listed twice",
    );
    expect(errorOf(await read({ ready: ["KAN-41", "KAN-42"] }, true))).toContain("name is required");
    expect(errorOf(await read({ name: "p", ready: ["KAN-41"], notReady: [{ ref: "KAN-42", questions: [] }] }, true))).toContain("invalid");
  });
});
