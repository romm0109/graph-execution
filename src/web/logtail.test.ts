import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FULL_BYTES, labelsForNode, LogTail } from "./logtail.js";

let dir: string;
let tail: LogTail | undefined;
beforeEach(() => void (dir = mkdtempSync(path.join(tmpdir(), "logtail-"))));
afterEach(() => {
  tail?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("LogTail", () => {
  it("streams appended text within 2s, with its byte offset", async () => {
    writeFileSync(path.join(dir, "3.log"), "abc\n");
    const got: [string, number, string][] = [];
    tail = new LogTail(dir, (l, o, t) => got.push([l, o, t]));
    const off = tail.subscribe(["3"]);
    appendFileSync(path.join(dir, "3.log"), "hello\n");
    const end = Date.now() + 2000;
    while (got.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual([["3", 4, "hello\n"]]);
    off();
  });

  it("rejects invalid, unknown and too many labels", () => {
    tail = new LogTail(dir, () => {});
    expect(() => tail!.subscribe(["../x"])).toThrow(/invalid/);
    expect(() => tail!.subscribe(["nope"])).toThrow(/unknown/);
    const labels = Array.from({ length: 17 }, (_, i) => `l${i}`);
    for (const l of labels) writeFileSync(path.join(dir, `${l}.log`), "");
    expect(() => tail!.subscribe(labels)).toThrow(/at most 16/);
  });

  it("lists a tail and truncates a full read", async () => {
    tail = new LogTail(dir, () => {});
    writeFileSync(path.join(dir, "a.log"), "x".repeat(20000));
    writeFileSync(path.join(dir, "b.txt"), "no");
    const list = await tail.list();
    expect(list.map((l) => l.label)).toEqual(["a"]);
    expect(list[0]!.size).toBe(20000);
    expect(list[0]!.tail).toHaveLength(8192);
    writeFileSync(path.join(dir, "big.log"), "y".repeat(FULL_BYTES + 10));
    const full = await tail.full("big");
    expect(full.truncated).toBe(true);
    expect(full.text).toHaveLength(FULL_BYTES);
    await expect(tail.full("../a")).rejects.toThrow(/invalid/);
  });
});

describe("labelsForNode", () => {
  const labels = ["3", "3-validate-1", "30", "code-r1", "tester-r2", "fix-r1", "fix-r1-v2", "summary-3", "summary--reviewer"];
  it("maps nodes to their logs", () => {
    expect(labelsForNode("3", labels)).toEqual(["3", "3-validate-1", "summary-3"]);
    expect(labelsForNode("@reviewer", labels)).toEqual(["code-r1", "summary--reviewer"]);
    expect(labelsForNode("@tester", labels)).toEqual(["tester-r2"]);
    expect(labelsForNode("@fixer", labels)).toEqual(["fix-r1", "fix-r1-v2"]);
    expect(labelsForNode("@gate-fixer", labels)).toEqual(["fix-r1-v2"]);
  });
});
