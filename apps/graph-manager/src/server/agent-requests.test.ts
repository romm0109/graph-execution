import { describe, expect, it } from "vitest";
import { AGENT_REQUEST_TTL_MS, AgentRequests, REFRESH_TTL_MS } from "./agent-requests.js";

const req = (terminalId: string, tasksDir = "tasks") => ({
  kind: "start-run" as const,
  terminalId,
  workspaceId: "github~o~r",
  prefill: { tasksDir, spec: "spec.md" },
});

const openRun = (terminalId: string, runId: string) => ({ kind: "open-run" as const, terminalId, workspaceId: "github~o~r", runId });
const refresh = () => ({ kind: "refresh" as const, workspaceId: "github~o~r" });

describe("AgentRequests", () => {
  it("adds, lists oldest first and acks", () => {
    const q = new AgentRequests();
    const a = q.add(req("t1"));
    const b = q.add(req("t2"));
    expect(a.id).not.toBe(b.id);
    expect(a.createdAt).toMatch(/^\d{4}-/);
    expect(q.list().map((r) => r.id)).toEqual([a.id, b.id]);
    expect(q.ack(a.id)).toBe(true);
    expect(q.list().map((r) => r.id)).toEqual([b.id]);
    expect(q.ack(a.id)).toBe(false);
    expect(q.ack("nope")).toBe(false);
  });

  it("replaces a pending request of the same terminal", () => {
    const q = new AgentRequests();
    const a = q.add(req("t1", "one"));
    const b = q.add(req("t1", "two"));
    const list = q.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(b.id);
    expect(list[0]!.id).not.toBe(a.id);
    const r = list[0]!;
    expect(r.kind === "start-run" && r.prefill.tasksDir).toBe("two");
  });

  it("drops requests older than the TTL", () => {
    let t = 1_000_000;
    const q = new AgentRequests(() => t);
    q.add(req("t1"));
    t += AGENT_REQUEST_TTL_MS - 1;
    const b = q.add(req("t2"));
    expect(q.list()).toHaveLength(2);
    t += 2;
    expect(q.list().map((r) => r.id)).toEqual([b.id]);
  });

  it("replaces only a pending request of the same terminal and kind", () => {
    const q = new AgentRequests();
    const s = q.add(req("t1"));
    const o1 = q.add(openRun("t1", "gm-20261109-101500-ab12"));
    expect(q.list().map((r) => r.id)).toEqual([s.id, o1.id]);
    const o2 = q.add(openRun("t1", "gm-20261109-101600-cd34"));
    const list = q.list();
    expect(list.map((r) => r.id)).toEqual([s.id, o2.id]);
    const last = list[1]!;
    expect(last.kind === "open-run" && last.runId).toBe("gm-20261109-101600-cd34");
  });

  it("keeps every refresh request", () => {
    const q = new AgentRequests();
    const a = q.add(refresh());
    const b = q.add(refresh());
    expect(q.list().map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it("drops refresh requests after REFRESH_TTL_MS, other kinds stay", () => {
    let t = 1_000_000;
    const q = new AgentRequests(() => t);
    const s = q.add(req("t1"));
    const r = q.add(refresh());
    t += REFRESH_TTL_MS;
    expect(q.list().map((x) => x.id)).toEqual([s.id, r.id]);
    t += 1;
    expect(q.list().map((x) => x.id)).toEqual([s.id]);
  });

  it("does not ack a refresh request", () => {
    const q = new AgentRequests();
    const r = q.add(refresh());
    expect(q.ack(r.id)).toBe(false);
    expect(q.list().map((x) => x.id)).toEqual([r.id]);
  });

  it("gets a pending request by id", () => {
    const q = new AgentRequests();
    const a = q.add(req("t1"));
    expect(q.get(a.id)).toEqual(a);
    expect(q.ack(a.id)).toBe(true);
    expect(q.get(a.id)).toBeUndefined();
    expect(q.get("nope")).toBeUndefined();
  });
});
