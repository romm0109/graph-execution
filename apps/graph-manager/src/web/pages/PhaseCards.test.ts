import { describe, expect, it } from "vitest";
import type { CachedView, RunDetailResponse } from "../runs";
import { phaseCards } from "./PhaseCards";

function detail(view: Partial<CachedView>, status = "applied"): RunDetailResponse {
  return {
    summary: { status } as RunDetailResponse["summary"],
    state: { runId: "r1", provider: "fake", createdAt: "", status, tasks: {} },
    view: { version: 1, runId: "r1", savedAt: "", final: true, phase: { phase: "done" }, nodes: {}, agents: {}, ...view },
    tasks: [],
  };
}

const reviewCard = (d: RunDetailResponse) => phaseCards(d, "octo/hello").find((c) => c.key === "review")!;

describe("phaseCards review card", () => {
  it("lists every reviewer with its status and open findings", () => {
    const card = reviewCard(
      detail(
        {
          agents: { reviewer: { status: "done" }, tester: { status: "done" }, security: { status: "failed" } },
          reviewers: [
            { id: "code", title: "Code review", node: { status: "done" }, findings: { blocker: 0, major: 0, minor: 2 } },
            { id: "tester", title: "Live test", node: { status: "done" } },
            { id: "security", title: "Security", node: { status: "failed" }, findings: { blocker: 0, major: 1, minor: 1 } },
          ],
        },
        "failed",
      ),
    );
    expect(card.status).toBe("failed");
    expect(card.detail).toBe("Code review + Live test + Security");
    expect(card.rows?.map((r) => r.tone)).toEqual(["ok", "ok", "bad"]);
    expect(card.rows?.map((r) => r.status)).toEqual(["passed", "passed", "failed"]);
    expect(card.rows?.[2]).toEqual({ id: "security", name: "Security", status: "failed", tone: "bad", counts: "0 blocker · 1 major · 1 minor" });
    expect(card.rows?.[1]?.counts).toBeUndefined();
  });

  it("is skipped when the run has no enabled reviewer", () => {
    const card = reviewCard(detail({ reviewers: [], summary: { exitCode: 0, fixPasses: 3, findings: 0 } }));
    expect(card.status).toBe("skipped");
    expect(card.detail).toBe("no reviewers enabled");
    expect(card.rows).toEqual([]);
  });

  it("keeps the legacy card for a view cached before reviewers", () => {
    const card = reviewCard(
      detail({ agents: { reviewer: { status: "done" }, tester: { status: "done" } }, summary: { exitCode: 0, fixPasses: 3, findings: 3 } }),
    );
    expect(card.status).toBe("passed · 3 findings");
    expect(card.detail).toBe("code reviewer + live tester");
    expect(card.rows).toBeUndefined();
  });
});
