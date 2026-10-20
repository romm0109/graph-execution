import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeProvider, fakeScriptSchema } from "../providers/fake.js";
import type { Provider } from "../providers/types.js";
import { SUMMARY_PATH_PATTERN } from "../review/report.js";
import { failureSummaryPrompt, readLogTail, runFailureSummary } from "./summarizer.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "graph-execution-summary-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const good = { cause: "it timed out", verdict: "likely_to_work", why: "timeouts are transient" };
const summarize = (provider: Provider) =>
  runFailureSummary({
    provider,
    runDir: dir,
    nodeId: "2",
    label: "2",
    title: "task 2",
    kind: "task",
    error: "agent exited with code 1",
    attempts: ["attempt 1 of 3 failed: boom"],
    logTail: "last line",
    signal: new AbortController().signal,
  });
const scripted = (summary: unknown) =>
  createFakeProvider(fakeScriptSchema.parse({ "summarizer:summary-2": { attempts: [{ summary }] } }));

describe("failureSummaryPrompt", () => {
  it("contains the error, the log tail and the path line", () => {
    const prompt = failureSummaryPrompt({
      title: "task 2",
      kind: "task",
      error: "agent exited with code 1",
      attempts: ["attempt 1 of 3 failed: boom"],
      logTail: "tail of the log",
      path: "/tmp/x.json",
    });
    expect(prompt).toContain("agent exited with code 1");
    expect(prompt).toContain("tail of the log");
    expect(prompt).toContain("attempt 1 of 3 failed: boom");
    expect(SUMMARY_PATH_PATTERN.exec(prompt)?.[1]).toBe("/tmp/x.json");
  });
});

describe("runFailureSummary", () => {
  it("reads a valid summary", async () => {
    expect(await summarize(scripted(good))).toEqual(good);
  });
  it("accepts JSON inside a code fence", async () => {
    expect(await summarize(scripted(`\`\`\`json\n${JSON.stringify(good)}\n\`\`\``))).toEqual(good);
  });
  it("gives undefined for invalid JSON, a wrong verdict, a missing file or a thrown provider", async () => {
    expect(await summarize(scripted("not json"))).toBeUndefined();
    expect(await summarize(scripted({ ...good, verdict: "maybe" }))).toBeUndefined();
    expect(await summarize(scripted(null))).toBeUndefined();
    const throwing = createFakeProvider(fakeScriptSchema.parse({ "summarizer:summary-2": { attempts: [{ throw: "x" }] } }));
    expect(await summarize(throwing)).toBeUndefined();
  });
});

describe("readLogTail", () => {
  it("keeps the last 60 lines and caps the characters", async () => {
    await writeFile(path.join(dir, "2.log"), Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
    const tail = (await readLogTail(dir, "2")).split("\n");
    expect(tail).toHaveLength(60);
    expect(tail.at(-1)).toBe("line 99");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "big.log"), "x".repeat(10_000));
    expect(await readLogTail(dir, "big")).toHaveLength(4000);
    expect(await readLogTail(dir, "missing")).toBe("");
  });
});
