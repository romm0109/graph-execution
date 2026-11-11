import { describe, expect, it } from "vitest";
import { configSchema } from "../config/config.js";
import { UsageError } from "../launch/preflight.js";
import { resolveSandboxSettings } from "./settings.js";

const config = (sandbox?: object) => configSchema.parse(sandbox ? { sandbox } : {});

describe("resolveSandboxSettings", () => {
  it("uses the defaults without config or flags", () => {
    expect(resolveSandboxSettings(config(), { sandbox: true })).toEqual({
      base: "node:24.22.1-bookworm",
      lines: [],
      cpus: 2,
      memoryMb: 4096,
      pids: 2048,
      env: [],
    });
  });

  it("puts the flags over the config", () => {
    const c = config({ base: "node:22-bookworm", dockerfile: ["RUN a"], cpus: 4, env: ["FOO"] });
    expect(resolveSandboxSettings(c, { sandbox: true })).toMatchObject({ base: "node:22-bookworm", lines: ["RUN a"], cpus: 4, env: ["FOO"] });
    expect(
      resolveSandboxSettings(c, { sandbox: true, sandboxBase: "x:1", sandboxLine: ["RUN b"], sandboxCpus: 1, sandboxMemory: 512, sandboxPids: 100 }),
    ).toMatchObject({ base: "x:1", lines: ["RUN a", "RUN b"], cpus: 1, memoryMb: 512, pids: 100 });
    expect(resolveSandboxSettings(c, { sandbox: true, sandboxConfigLines: false, sandboxLine: ["RUN b"] }).lines).toEqual(["RUN b"]);
  });

  it("takes a ready-made image from the flags or the config", () => {
    expect(resolveSandboxSettings(config({ image: "cfg/img" }), { sandbox: true }).image).toBe("cfg/img");
    expect(resolveSandboxSettings(config({ image: "cfg/img" }), { sandbox: true, sandboxImage: "flag/img" }).image).toBe("flag/img");
    expect(resolveSandboxSettings(config({ image: "cfg/img" }), { sandbox: true, sandboxBase: "b:1" }).image).toBeUndefined();
  });

  it("refuses a ready-made image with --sandbox-base or --sandbox-line", () => {
    for (const flags of [{ sandboxBase: "b" }, { sandboxLine: ["RUN a"] }]) {
      expect(() => resolveSandboxSettings(config(), { sandbox: true, sandboxImage: "i", ...flags })).toThrow(
        "--sandbox-image is a ready-made image; it cannot be combined with --sandbox-base or --sandbox-line",
      );
    }
  });

  it("refuses image flags without --sandbox, naming the first one", () => {
    expect(() => resolveSandboxSettings(config(), { sandboxImage: "i" })).toThrow("--sandbox-image needs --sandbox");
    expect(() => resolveSandboxSettings(config(), { sandboxBase: "b", sandboxPids: 100 })).toThrow("--sandbox-base needs --sandbox");
    expect(() => resolveSandboxSettings(config(), { sandboxMemory: 512 })).toThrow(UsageError);
  });

  it("refuses a FROM line", () => {
    expect(() => resolveSandboxSettings(config(), { sandbox: true, sandboxLine: ["FROM x"] })).toThrow(
      "FROM is not allowed in sandbox Dockerfile lines; use COPY --from=<image>",
    );
  });
});
