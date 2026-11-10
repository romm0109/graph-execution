import { describe, expect, it } from "vitest";
import { RunOrigins } from "./run-origins.js";

describe("RunOrigins", () => {
  it("sets, gets and deletes", () => {
    const o = new RunOrigins();
    expect(o.get("ws", "r1")).toBeUndefined();
    o.set("ws", "r1", "t1");
    expect(o.get("ws", "r1")).toBe("t1");
    expect(o.entries()).toMatchObject([{ wsId: "ws", runId: "r1", terminalId: "t1" }]);
    o.delete("ws", "r1");
    expect(o.get("ws", "r1")).toBeUndefined();
    expect(o.entries()).toEqual([]);
  });

  it("replaces the terminal of a run set twice", () => {
    const o = new RunOrigins();
    o.set("ws", "r1", "t1");
    o.set("ws", "r1", "t2");
    expect(o.get("ws", "r1")).toBe("t2");
    expect(o.entries()).toHaveLength(1);
  });

  it("keeps runs of two workspaces with the same id apart", () => {
    const o = new RunOrigins();
    o.set("a", "r1", "t1");
    o.set("b", "r1", "t2");
    expect(o.get("a", "r1")).toBe("t1");
    expect(o.get("b", "r1")).toBe("t2");
    o.delete("a", "r1");
    expect(o.get("b", "r1")).toBe("t2");
  });

  it("returns copies from entries()", () => {
    const o = new RunOrigins();
    o.set("ws", "r1", "t1");
    o.entries()[0]!.terminalId = "tX";
    expect(o.get("ws", "r1")).toBe("t1");
  });
});
