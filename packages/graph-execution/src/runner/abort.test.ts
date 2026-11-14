import { describe, expect, it } from "vitest";
import { resumeCommand } from "./abort.js";

describe("resumeCommand", () => {
  it("gives the plain command outside a sandbox", () => {
    expect(resumeCommand("r1", {})).toBe("graph-execution --resume --run r1");
  });

  it("points a sandboxed run at graph-manager (KAN-88 T2)", () => {
    expect(resumeCommand("r1", { GRAPH_EXECUTION_SANDBOX: "1" })).toBe(
      "press Resume in graph-manager, or graph-execution --resume --run r1 --sandbox in a graph-manager terminal",
    );
  });
});
