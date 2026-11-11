import { describe, expect, it } from "vitest";
import { FROM_ERROR, resolveImage, sandboxDockerfile, sandboxImageTag, sandboxPackages } from "./image.js";

const settings = { base: "node:24.22.1-bookworm", lines: [] as string[] };

describe("sandbox image", () => {
  it("installs the claude CLI for claude", () => {
    const d = sandboxDockerfile(settings, ["claude"]);
    expect(d.startsWith("FROM node:24.22.1-bookworm\n")).toBe(true);
    expect(d).toContain("RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code\n");
    expect(d).toContain("RUN mkdir -p /home/sandbox && chmod 1777 /home/sandbox");
  });

  it("adds bun for omp", () => {
    expect(sandboxPackages(["omp"])).toEqual(["@oh-my-pi/pi-coding-agent", "bun"]);
  });

  it("installs every catalog package and bun without a provider, in catalog order", () => {
    const pkgs = sandboxPackages([]);
    expect(pkgs).toHaveLength(8);
    expect(pkgs[0]).toBe("@anthropic-ai/claude-code");
    expect(pkgs.at(-1)).toBe("bun");
  });

  it("dedups and ignores fake", () => {
    expect(sandboxPackages(["omp", "claude", "omp", "fake"])).toEqual(["@anthropic-ai/claude-code", "@oh-my-pi/pi-coding-agent", "bun"]);
    expect(sandboxDockerfile(settings, ["fake"])).not.toContain("npm install");
  });

  it("gives a stable tag of 12 hex", () => {
    const a = resolveImage(settings, ["claude"]);
    const b = resolveImage(settings, ["claude"]);
    expect(a).toEqual(b);
    expect(a.kind === "build" && a.tag).toMatch(/^graph-execution-sandbox:[0-9a-f]{12}$/);
    expect(sandboxImageTag("x")).not.toBe(sandboxImageTag("y"));
  });

  it("rejects a FROM line", () => {
    expect(() => sandboxDockerfile({ ...settings, lines: ["  from node:20"] })).toThrow(FROM_ERROR);
  });

  it("replaces the base and keeps the lines in order, dropping CRs and trailing blank lines", () => {
    const d = sandboxDockerfile({ base: "python:3.12-bookworm", lines: ["RUN a\r", "RUN b", "", ""] }, ["pi"]);
    expect(d.startsWith("FROM python:3.12-bookworm\n")).toBe(true);
    expect(d.endsWith("chmod 1777 /home/sandbox\nRUN a\nRUN b\n")).toBe(true);
  });

  it("returns a ready-made image as is", () => {
    expect(resolveImage({ ...settings, image: "my/img:1" })).toEqual({ kind: "ready", image: "my/img:1" });
  });
});
