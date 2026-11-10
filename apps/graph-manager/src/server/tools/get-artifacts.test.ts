import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toolApp, writeRun, type ToolApp } from "./tool-test-helpers.js";

let t: ToolApp;
const ID = "gm-20261106-100000-aaaa";

beforeEach(async () => {
  t = await toolApp();
});
afterEach(async () => {
  await t.cleanup();
});

const git = async (...args: string[]) => String((await execa("git", args, { cwd: t.wsDir })).stdout);
const commit = (msg: string) => git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", msg);

/** A base commit with keep.txt and gone.txt, then graph/<ID> adding src/a.ts, modifying keep.txt, deleting gone.txt. */
async function runBranch(): Promise<string> {
  await writeFile(path.join(t.wsDir, "keep.txt"), "one\n");
  await writeFile(path.join(t.wsDir, "gone.txt"), "x\ny\n");
  await git("add", ".");
  await commit("base");
  const base = (await git("rev-parse", "HEAD")).trim();
  await git("checkout", "-q", "-b", `graph/${ID}`);
  await mkdir(path.join(t.wsDir, "src"));
  await writeFile(path.join(t.wsDir, "src", "a.ts"), "a\nb\nc\n");
  await writeFile(path.join(t.wsDir, "keep.txt"), "one\ntwo\n");
  await rm(path.join(t.wsDir, "gone.txt"));
  await git("add", "-A");
  await commit("task 1");
  await git("checkout", "-q", "main");
  return base;
}

describe.skipIf(process.platform === "win32")("get_artifacts", () => {
  it("lists the files an applied run changed and its report files", async () => {
    const base = await runBranch();
    const dir = await writeRun(t.wsDir, ID, { status: "applied", startingCommit: base, integrationBranch: `graph/${ID}`, targetBranch: "main" });
    await mkdir(path.join(dir, "reports", "round1"), { recursive: true });
    await writeFile(path.join(dir, "reports", "round1", "code.json"), "{}");
    await writeFile(path.join(dir, "run.log"), "log\n");
    await mkdir(path.join(dir, "summaries", "work"), { recursive: true });
    await writeFile(path.join(dir, "summaries", "work", "x.json"), "{}");
    const r = await t.call("get_artifacts", { runId: ID });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain(`Run ${ID} was applied to main as uncommitted changes. Files it changed (${base.slice(0, 7)}..graph/${ID}):`);
    expect(r.text).toContain("| src/a.ts | added | +3 -0 |");
    expect(r.text).toContain("| keep.txt | modified | +1 -0 |");
    expect(r.text).toContain("| gone.txt | deleted | +0 -2 |");
    expect(r.text).not.toContain("state.json");
    expect(r.text).toContain(`Report files:\n- .graph-execution/${ID}/reports/round1/code.json\n- .graph-execution/${ID}/run.log`);
    expect(r.text).not.toContain("work/x.json");
  });

  it("says an unfinished run shows what is merged so far", async () => {
    const base = await runBranch();
    await writeRun(t.wsDir, ID, { status: "failed", startingCommit: base });
    const r = await t.call("get_artifacts", { runId: ID });
    expect(r.text).toContain(`Run ${ID} is failed: not finished, this is what is merged into graph/${ID} so far.`);
    expect(r.text).toContain("| src/a.ts | added | +3 -0 |");
    expect(r.text).toContain("Report files:\nnone");
  });

  it("falls back to the working tree when an applied run's branch is gone", async () => {
    await writeRun(t.wsDir, ID, { status: "applied", targetBranch: "main" });
    await writeFile(path.join(t.wsDir, "new.txt"), "n\n");
    const r = await t.call("get_artifacts", { runId: ID });
    expect(r.text).toContain(`(from the working tree: the result branch graph/${ID} is gone; it may include your own uncommitted changes)`);
    expect(r.text).toContain("| new.txt | added | +? |");
  });

  it("says when the branch of an unapplied run is gone, and when the diff fails", async () => {
    await writeRun(t.wsDir, ID, { status: "done" });
    const gone = await t.call("get_artifacts", { runId: ID });
    expect(gone.isError).toBeFalsy();
    expect(gone.text).toContain(`Run ${ID} is done; the result is on branch graph/${ID}.`);
    expect(gone.text).toContain(`The result branch graph/${ID} is gone; no changed files to show.`);
    await git("branch", `graph/${ID}`);
    const bad = await t.call("get_artifacts", { runId: ID });
    expect(bad.text).toContain(`could not diff ${"0".repeat(40)}..graph/${ID} (git failed)`);
  });

  it("refuses unknown runs and terminals outside a workspace", async () => {
    expect(await t.call("get_artifacts", { runId: "nope-run" })).toEqual({ isError: true, text: "unknown run nope-run" });
    expect(await t.call("get_artifacts", { runId: ID }, { terminalId: t.rootTerminalId, cwd: t.config.workspacesDir })).toEqual({
      isError: true,
      text: "this terminal is not inside a graph-manager workspace",
    });
  });
});
