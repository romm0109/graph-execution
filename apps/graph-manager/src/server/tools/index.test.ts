import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TOOLS, toolList } from "./index.js";
import { defineTool } from "./types.js";

describe("TOOLS", () => {
  it("have unique snake_case names, descriptions and object input schemas", () => {
    const names = new Set<string>();
    const list = toolList();
    expect(list).toHaveLength(TOOLS.length);
    for (const [i, t] of TOOLS.entries()) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
      expect(t.description.trim()).not.toBe("");
      expect(list[i]!.inputSchema.type).toBe("object");
    }
  });

  it("lists a tool's input as JSON Schema", () => {
    const tool = defineTool({ name: "t", description: "d", input: z.object({ a: z.string() }), run: async (i) => ({ text: i.a }) });
    const [entry] = toolList([tool]);
    expect(entry).toMatchObject({ name: "t", description: "d" });
    expect(entry!.inputSchema.type).toBe("object");
    expect(entry!.inputSchema.required).toEqual(["a"]);
  });
});
