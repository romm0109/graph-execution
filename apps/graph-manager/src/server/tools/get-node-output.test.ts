import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
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

async function writeLog(dir: string, name: string, text: string): Promise<string> {
  await mkdir(path.join(dir, "logs"), { recursive: true });
  const file = path.join(dir, "logs", name);
  await writeFile(file, text);
  return file;
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n") + "\n";

describe.skipIf(process.platform === "win32")("get_node_output", () => {
  it("shows a failed task's status and the tail of its agent log", async () => {
    const dir = await writeRun(t.wsDir, ID);
    await writeLog(dir, "2.log", lines(300));
    const r = await t.call("get_node_output", { runId: ID, node: "2" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain(`Node 2 of run ${ID}`);
    expect(r.text).toContain("status: failed, attempts: 2");
    expect(r.text).toContain(`agent log .graph-execution/${ID}/logs/2.log (last 200 lines):`);
    expect(r.text).toContain("```\nline101\n");
    expect(r.text).toContain("line300\n```");
    expect(r.text).not.toContain("line100\n");
    const few = await t.call("get_node_output", { runId: ID, node: "2", lines: 3 });
    expect(few.text).toContain("```\nline298\nline299\nline300\n```");
    expect(few.text).not.toContain("line297");
  });

  it("shows the newest validation output and lists the other logs", async () => {
    const dir = await writeRun(t.wsDir, ID);
    await writeLog(dir, "2.log", "agent\n");
    const old = await writeLog(dir, "2-validate-1.log", "v1\n");
    await utimes(old, new Date(1000), new Date(1000));
    await writeLog(dir, "2-validate-2.log", "v2\n");
    await writeLog(dir, "task-2-merge-resolver.log", "res\n");
    await writeLog(dir, "12.log", "other task\n");
    const r = await t.call("get_node_output", { runId: ID, node: "2" });
    expect(r.text).toContain(`validation output .graph-execution/${ID}/logs/2-validate-2.log:\n\`\`\`\nv2\n\`\`\``);
    expect(r.text).toContain(`other logs: .graph-execution/${ID}/logs/2-validate-1.log, .graph-execution/${ID}/logs/task-2-merge-resolver.log`);
    expect(r.text).not.toContain("12.log");
  });

  it("shows the error from the cached view and a failure summary", async () => {
    const dir = await writeRun(t.wsDir, ID);
    const views = path.join(t.config.dataDir, "views", t.wsId);
    await mkdir(views, { recursive: true });
    await writeFile(
      path.join(views, `${ID}.json`),
      JSON.stringify({ version: 1, runId: ID, savedAt: "x", final: true, phase: { phase: "done" }, nodes: { "2": { status: "failed", error: "agent exited with code 1" } }, agents: {} }),
    );
    await mkdir(path.join(dir, "summaries"), { recursive: true });
    await writeFile(path.join(dir, "summaries", "2-100.json"), JSON.stringify({ cause: "old", why: "old why" }));
    await writeFile(path.join(dir, "summaries", "2-200.json"), JSON.stringify({ cause: "Tests failed.", why: "A typo.", verdict: "x" }));
    const r = await t.call("get_node_output", { runId: ID, node: "2" });
    expect(r.text).toContain("error: agent exited with code 1");
    expect(r.text).toContain("summary: Tests failed. A typo.");
  });

  it("tails the newest log of a review node", async () => {
    const dir = await writeRun(t.wsDir, ID);
    const r1 = await writeLog(dir, "code-r1.log", "round one\n");
    await utimes(r1, new Date(1000), new Date(1000));
    await writeLog(dir, "code-r2.log", "round two\n");
    await writeLog(dir, "tester-r1.log", "tester\n");
    const r = await t.call("get_node_output", { runId: ID, node: "@reviewer" });
    expect(r.text).toContain(`Node @reviewer of run ${ID} (Code review)`);
    expect(r.text).toContain("status: unknown (no cached view of this run)");
    expect(r.text).toContain(`agent log .graph-execution/${ID}/logs/code-r2.log (last 1 lines):\n\`\`\`\nround two\n\`\`\``);
    expect(r.text).toContain(`other logs: .graph-execution/${ID}/logs/code-r1.log`);
    expect(r.text).not.toContain("tester-r1");
  });

  it("tells the fixer's logs from the validation fixer's", async () => {
    const dir = await writeRun(t.wsDir, ID);
    await writeLog(dir, "fix-r0-v1.log", "gate fix\n");
    await writeLog(dir, "fix-r1.log", "fix one\n");
    const fixer = await t.call("get_node_output", { runId: ID, node: "@fixer" });
    expect(fixer.text).toContain("fix one");
    expect(fixer.text).not.toContain("gate fix");
    const gateFixer = await t.call("get_node_output", { runId: ID, node: "@gate-fixer" });
    expect(gateFixer.text).toContain("gate fix");
    expect(gateFixer.text).not.toContain("fix one");
  });

  it("refuses an unknown node with the valid ones", async () => {
    await writeRun(t.wsDir, ID);
    expect(await t.call("get_node_output", { runId: ID, node: "9" })).toEqual({
      isError: true,
      text: `unknown node 9 in run ${ID}; nodes: 1, 2, @gate, @gate-fixer, @reviewer, @tester, @fixer, @merge`,
    });
    const traversal = await t.call("get_node_output", { runId: ID, node: "../state" });
    expect(traversal.isError).toBe(true);
  });

  it("says when a node has no log yet", async () => {
    await writeRun(t.wsDir, ID);
    const r = await t.call("get_node_output", { runId: ID, node: "1" });
    expect(r.text).toContain("status: merged, attempts: 1");
    expect(r.text).toContain("no agent log for 1 yet");
  });

  it("refuses unknown runs and terminals outside a workspace", async () => {
    expect(await t.call("get_node_output", { runId: "nope-run", node: "1" })).toEqual({ isError: true, text: "unknown run nope-run" });
    expect(await t.call("get_node_output", { runId: ID, node: "1" }, { terminalId: t.rootTerminalId, cwd: t.config.workspacesDir })).toEqual({
      isError: true,
      text: "this terminal is not inside a graph-manager workspace",
    });
  });
});
