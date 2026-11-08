import { describe, expect, it } from "vitest";
import { AGENT_REQUEST_TTL_MS, AgentRequests } from "./agent-requests.js";

const req = (terminalId: string, tasksDir = "tasks") => ({
  kind: "start-run" as const,
  terminalId,
  workspaceId: "github~o~r",
  prefill: { tasksDir, spec: "spec.md" },
});

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
    expect(list[0]!.prefill.tasksDir).toBe("two");
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
});
