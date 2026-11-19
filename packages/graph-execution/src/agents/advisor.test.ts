import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EscalationRecord } from "../escalation/schema.js";
import { createFakeProvider } from "../providers/fake.js";
import { ADVISOR_UNAVAILABLE, AdvisorError, AdvisorSessions, advisorContext, advisorContextPath, shellArg } from "./advisor.js";

let runDir: string;
beforeEach(async () => {
  runDir = path.join(await mkdtemp(path.join(os.tmpdir(), "advisor-")), "20260101-000000-abcd");
  await mkdir(path.join(runDir, "escalations"), { recursive: true });
});
afterEach(async () => {
  await rm(path.dirname(runDir), { recursive: true, force: true });
});

const record = (id: string, node: string, over: Partial<EscalationRecord> = {}): EscalationRecord => ({
  id,
  node,
  source: "agent",
  attempt: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "open",
  reason: `reason of ${id}`,
  evidence: `evidence of ${id}`,
  questions: [{ id: "q1", question: "A or B?", suggestedOptions: ["A", "B"] }],
  ...over,
});

describe("advisorContext", () => {
  it("writes the escalation, the other open ones, the paths, the diff, the format and the rules", async () => {
    const ctx = await advisorContext({
      runDir,
      runId: "20260101-000000-abcd",
      record: record("E1", "2", { branch: "graph-task/r/2" }),
      others: [record("E2", "4")],
      specPath: "/run/context/spec/spec.md",
      tasksPath: "/run/context/tasks/",
      tasks: [
        { id: "1", content: "# First task\n\nMore.", dependencies: [] },
        { id: "2", content: "\nSecond task", dependencies: ["1"] },
      ],
      states: { "1": { status: "merged", attempts: 1 }, "2": { status: "escalated", attempts: 1, baseSha: "abc123" } },
      integrationBranch: "graph/r",
      nodePath: "/usr/bin/node",
      cliPath: "/opt/ge/cli.js",
    });
    expect(ctx.file).toBe(advisorContextPath(runDir, "E1"));
    const draft = path.join(runDir, "escalations", "E1", "draft.json");
    expect(ctx.draft).toBe(draft);
    expect(ctx.apply).toEqual(["/usr/bin/node", "/opt/ge/cli.js", "resolve", "--run", "20260101-000000-abcd", "--file", draft]);
    const text = await readFile(ctx.file, "utf8");
    for (const section of ["# Escalation E1", "## Other open escalations", "## Spec", "## Tasks", "## The escalated work", "## Resolution format", "## Rules"]) {
      expect(text).toContain(`${section}\n`);
    }
    expect(text).toContain("Reason: reason of E1");
    expect(text).toContain("- q1: A or B?");
    expect(text).toContain("Suggested options: A | B");
    expect(text).toContain("- E2 (task 4, open): reason of E2");
    expect(text).toContain("/run/context/spec/spec.md");
    expect(text).toContain("The full task files: /run/context/tasks/");
    expect(text).toContain("- 1 (merged): # First task");
    expect(text).toContain("- 2 (escalated, after 1): Second task");
    expect(text).toContain("git diff abc123..graph-task/r/2");
    expect(text).toContain('"action": "continue"');
    expect(text).toContain('"action": "change"');
    expect(text).toContain("Don't change the repository");
    expect(text).toContain(`Draft file: ${draft}\n`);
    expect(text).toContain(`Apply command: ${JSON.stringify(ctx.apply)}\n`);
    expect(text).toContain(`/usr/bin/node /opt/ge/cli.js resolve --run 20260101-000000-abcd --file ${draft}`);
  });
});

describe("AdvisorSessions", () => {
  const sessions = (over: Partial<ConstructorParameters<typeof AdvisorSessions>[0]> = {}) =>
    new AdvisorSessions({
      runDir,
      runId: path.basename(runDir),
      repo: runDir,
      provider: createFakeProvider(),
      integrationBranch: "graph/x",
      getTasks: () => [],
      getStates: () => ({}),
      ...over,
    });
  const save = (r: EscalationRecord) => writeFile(path.join(runDir, "escalations", `${r.id}.json`), JSON.stringify(r));

  it("refuses an unknown, a resolved escalation, and a provider without an interactive mode", async () => {
    await save(record("E1", "2", { status: "resolved" }));
    await save(record("E2", "3"));
    await expect(sessions().start("E9")).rejects.toMatchObject({ code: "unknown", status: 404 });
    await expect(sessions().start("E1")).rejects.toMatchObject({ code: "not_open", status: 409 });
    const bare = { name: "plain", run: createFakeProvider().run };
    await expect(sessions({ provider: bare }).start("E2")).rejects.toThrow("the plain provider has no interactive mode");
  });

  it("is unavailable when node-pty can't be loaded", async () => {
    await save(record("E1", "2"));
    const err = await sessions({ loadPty: () => Promise.reject(new Error("Cannot find module 'node-pty'")) })
      .start("E1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdvisorError);
    expect(err).toMatchObject({ code: "unavailable", status: 501, message: ADVISOR_UNAVAILABLE });
  });
});

describe("shellArg", () => {
  it("keeps Windows paths as they are and quotes them with cmd/PowerShell rules", () => {
    expect(shellArg("C:\\Users\\me\\draft.json", "win32")).toBe("C:\\Users\\me\\draft.json");
    expect(shellArg("C:\\Program Files\\node.exe", "win32")).toBe('"C:\\Program Files\\node.exe"');
    expect(shellArg('say "hi"', "win32")).toBe('"say ""hi"""');
  });
  it("quotes and escapes POSIX arguments for sh", () => {
    expect(shellArg("/opt/ge/cli.js", "linux")).toBe("/opt/ge/cli.js");
    expect(shellArg("/my dir/$x", "darwin")).toBe('"/my dir/\\$x"');
  });
});
