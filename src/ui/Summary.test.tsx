import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { RunEnd } from "../runner/events.js";
import type { Report } from "../review/report.js";
import { shellPath, Summary, summaryLines } from "./Summary.js";

const runDir = "/repo/.graph-execution/r1";
const blocker = {
  id: "F1",
  severity: "blocker" as const,
  file: "src/a.ts",
  line: 3,
  description: "Crashes on empty input.",
  failureScenario: "Calling parse('') throws.",
  status: "not_fixed" as const,
};
const minor = { id: "F2", severity: "minor" as const, description: "Naming could be clearer.", status: "open" as const };
const reports = (code: Report["findings"]): Report[] => [
  { round: 1, reviewer: "code", findings: code },
  { round: 1, reviewer: "tester", notes: ["live test not performed: no start script"], findings: [{ ...minor, id: "T1" }] },
];
const end = (change: Partial<RunEnd>): RunEnd => ({
  runId: "r1",
  branch: "graph/r1",
  exitCode: 0,
  reports: reports([minor]),
  fixPasses: 3,
  runDir,
  ...change,
});

describe("summaryLines", () => {
  it("exit 0: branch, counts by severity, minors, tester notes and how to merge", () => {
    const lines = summaryLines(end({}));
    expect(lines[0]).toBe("Run r1 finished: no open blocker or major finding");
    expect(lines).toContain("branch graph/r1");
    expect(lines).toContain("exit code 0 (clean)");
    expect(lines).toContain("Findings of the last review (round 1):");
    expect(lines.find((l) => l.includes("blocker") && l.includes("minor"))).toMatch(/blocker +major +minor$/);
    expect(lines).toContain("  code review          0        0        1");
    expect(lines).toContain("  live test            0        0        1");
    expect(lines).toContain("  - [code review] F2 (minor): Naming could be clearer.");
    expect(lines).toContain("  - [live test] T1 (minor): Naming could be clearer.");
    expect(lines).toContain("Notes:");
    expect(lines).toContain("  - live test not performed: no start script");
    expect(lines).not.toContain("Open blockers and majors:");
    expect(lines).toContain("  - inspect the commits: git log graph/r1");
    expect(lines).toContain("  - bring it into your branch: git merge --squash --no-commit graph/r1");
    expect(lines.join("\n")).not.toContain("--resume");
  });

  it("exit 1: the open blockers and majors, where the reports are, and no merge before fixing them", () => {
    const lines = summaryLines(end({ exitCode: 1, reports: reports([blocker, minor]) }));
    expect(lines[0]).toBe("Run r1 finished with 1 open blocker/major finding(s) after 3 fix pass(es)");
    expect(lines).toContain("exit code 1 (review loop exhausted)");
    expect(lines).toContain("  code review          1        0        1");
    expect(lines).toContain("Open blockers and majors:");
    expect(lines).toContain("  - [code review] F1 (blocker) src/a.ts:3: Crashes on empty input.");
    expect(lines).toContain("  - [code review] F2 (minor): Naming could be clearer.");
    expect(lines).toContain(`  - read the open findings in ${runDir}/reports`);
    expect(lines).toContain("  - fix the remaining findings on graph/r1 before merging it: git merge --no-ff graph/r1");
  });

  it("exit 2: the failing step and the exact resume command", () => {
    const lines = summaryLines(
      end({
        exitCode: 2,
        reports: [],
        abort: { step: "task 2", message: "task 2 failed after 3 attempts", hint: "graph-execution --resume --run r1" },
      }),
    );
    expect(lines[0]).toBe("Run r1 aborted at task 2: task 2 failed after 3 attempts");
    expect(lines).toContain("exit code 2 (aborted)");
    expect(lines).toContain("  no review has run yet");
    expect(lines).not.toContain("Minor findings:");
    expect(lines).toContain("  - resume the run: graph-execution --resume --run r1");
    expect(lines).toContain(`  - state, worktrees and logs are kept in ${runDir}`);
    expect(lines.join("\n")).not.toContain("git merge");
  });
});

describe("Summary", () => {
  it("renders the same content in the terminal", () => {
    const app = render(<Summary end={end({ exitCode: 1, reports: reports([blocker]) })} />);
    const frame = app.lastFrame()!;
    expect(frame).toContain("branch graph/r1");
    expect(frame).toContain("Open blockers and majors");
    expect(frame).toContain("F1 (blocker) src/a.ts:3");
    expect(frame).toContain("live test not performed: no start script");
    expect(frame).toContain("git log graph/r1");
    app.unmount();
  });
});

describe("shellPath", () => {
  it("leaves plain paths alone", () => {
    expect(shellPath("src/a.ts", "darwin")).toBe("src/a.ts");
    expect(shellPath("src/a.ts", "win32")).toBe("src/a.ts");
  });

  it("uses POSIX single quotes off Windows and double quotes on it", () => {
    expect(shellPath("my file's.ts", "darwin")).toBe("'my file'\\''s.ts'");
    expect(shellPath("my file's.ts", "win32")).toBe('"my file\'s.ts"');
  });
});
