import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOverrides, CONFIG_FILE, ConfigError, defaultConfig, definedOverrides, loadConfig } from "./config.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "graph-execution-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const write = (content: string): Promise<void> => writeFile(path.join(dir, CONFIG_FILE), content);

describe("loadConfig", () => {
  it("returns the defaults when the file is absent", async () => {
    expect(await loadConfig(dir)).toEqual({
      setup: [],
      validate: [],
      validateParallel: false,
      validateAt: "task",
      attempts: 3,
      validationRounds: 3,
      fixPasses: 3,
      humanReview: false,
      keepRuns: 5,
      e2eReview: true,
      loopDetection: { repeats: 5 },
      idleTimeoutMinutes: 20,
    });
  });

  it("reads loopDetection as repeats or false, and rejects fewer than 2 repeats", async () => {
    await write(JSON.stringify({ loopDetection: { repeats: 8 } }));
    expect((await loadConfig(dir)).loopDetection).toEqual({ repeats: 8 });
    await write(JSON.stringify({ loopDetection: false }));
    expect((await loadConfig(dir)).loopDetection).toBe(false);
    await write(JSON.stringify({ loopDetection: {} }));
    expect((await loadConfig(dir)).loopDetection).toEqual({ repeats: 5 });
    await write(JSON.stringify({ loopDetection: { repeats: 1 } }));
    await expect(loadConfig(dir)).rejects.toThrow(ConfigError);
    await write(JSON.stringify({ loopDetection: true }));
    await expect(loadConfig(dir)).rejects.toThrow(ConfigError);
  });

  it("reads idleTimeoutMinutes as a number >= 0 and rejects anything else", async () => {
    await write(JSON.stringify({ idleTimeoutMinutes: 0.5 }));
    expect((await loadConfig(dir)).idleTimeoutMinutes).toBe(0.5);
    await write(JSON.stringify({ idleTimeoutMinutes: 0 }));
    expect((await loadConfig(dir)).idleTimeoutMinutes).toBe(0);
    for (const bad of [-1, "10", null]) {
      await write(JSON.stringify({ idleTimeoutMinutes: bad }));
      await expect(loadConfig(dir)).rejects.toThrow(ConfigError);
      await expect(loadConfig(dir)).rejects.toThrow(/idleTimeoutMinutes/);
    }
  });

  it("accepts keepRuns 0 and rejects negative values", async () => {
    await write(JSON.stringify({ keepRuns: 0 }));
    expect((await loadConfig(dir)).keepRuns).toBe(0);
    await write(JSON.stringify({ keepRuns: -1 }));
    await expect(loadConfig(dir)).rejects.toThrow(ConfigError);
  });

  it("reads reviewProvider and reviewModel, and rejects an unknown provider or an empty model", async () => {
    await write(JSON.stringify({ reviewProvider: "codex", reviewModel: "o3" }));
    expect(await loadConfig(dir)).toMatchObject({ reviewProvider: "codex", reviewModel: "o3" });
    await write(JSON.stringify({ reviewProvider: "nope" }));
    await expect(loadConfig(dir)).rejects.toThrow(ConfigError);
    await write(JSON.stringify({ reviewModel: " " }));
    await expect(loadConfig(dir)).rejects.toThrow(ConfigError);
  });

  it("reads humanReview and still rejects typos", async () => {
    await write(JSON.stringify({ humanReview: true }));
    expect((await loadConfig(dir)).humanReview).toBe(true);
    await write(JSON.stringify({ humanReviw: true }));
    await expect(loadConfig(dir)).rejects.toThrow(ConfigError);
  });

  it("reads the given keys and fills in the rest", async () => {
    await write(
      JSON.stringify({ setup: ["npm ci"], validate: ["npm test"], validateParallel: true, concurrency: 5, validationRounds: 1 }),
    );
    expect(await loadConfig(dir)).toEqual({
      setup: ["npm ci"],
      validate: ["npm test"],
      validateParallel: true,
      validateAt: "task",
      concurrency: 5,
      attempts: 3,
      validationRounds: 1,
      fixPasses: 3,
      humanReview: false,
      keepRuns: 5,
      e2eReview: true,
      loopDetection: { repeats: 5 },
      idleTimeoutMinutes: 20,
    });
  });

  it("rejects unknown keys, naming them", async () => {
    await write(JSON.stringify({ valdate: ["npm test"] }));
    const err = await loadConfig(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain(path.join(dir, CONFIG_FILE));
    expect((err as Error).message).toMatch(/valdate/);
  });

  it("rejects values of the wrong type", async () => {
    await write(JSON.stringify({ concurrency: 0, setup: "npm ci" }));
    await expect(loadConfig(dir)).rejects.toThrow(/concurrency[\s\S]*setup|setup[\s\S]*concurrency/);
  });

  it("reports invalid JSON with the file path", async () => {
    await write("{ setup: ");
    await expect(loadConfig(dir)).rejects.toThrow(`invalid JSON in ${path.join(dir, CONFIG_FILE)}`);
  });
});

describe("applyOverrides", () => {
  it("applies the given keys over the config and keeps the rest", () => {
    expect(applyOverrides(defaultConfig(), { attempts: 1, fixPasses: 0 })).toEqual({
      ...defaultConfig(),
      attempts: 1,
      fixPasses: 0,
    });
  });
  it("returns the config unchanged when nothing is set", () => {
    const config = defaultConfig();
    expect(applyOverrides(config, { attempts: undefined })).toBe(config);
    expect(applyOverrides(config, undefined)).toBe(config);
  });
  it("applies validateAt, validateParallel and fractional idle minutes", () => {
    const config = applyOverrides(defaultConfig(), { validateAt: "end", validateParallel: true, idleTimeoutMinutes: 0.5 });
    expect(config.validateAt).toBe("end");
    expect(config.validateParallel).toBe(true);
    expect(config.idleTimeoutMinutes).toBe(0.5);
  });
  it("throws a ConfigError naming the bad key", () => {
    expect(() => applyOverrides(defaultConfig(), { attempts: 0 })).toThrow(ConfigError);
    expect(() => applyOverrides(defaultConfig(), { attempts: 0 })).toThrow(/attempts/);
  });
  it("definedOverrides drops the unset keys", () => {
    expect(definedOverrides({ attempts: undefined, fixPasses: 2 })).toEqual({ fixPasses: 2 });
    expect(definedOverrides(undefined)).toEqual({});
  });
});

describe("sandbox section", () => {
  it("is absent by default and filled with defaults when present", async () => {
    expect((await loadConfig(dir)).sandbox).toBeUndefined();
    await write(JSON.stringify({ sandbox: {} }));
    expect((await loadConfig(dir)).sandbox).toEqual({
      base: "node:24.22.1-bookworm",
      dockerfile: [],
      cpus: 2,
      memoryMb: 4096,
      pids: 2048,
      env: [],
    });
  });

  it("accepts an image with Dockerfile lines", async () => {
    await write(JSON.stringify({ sandbox: { image: "ghcr.io/me/img:1", dockerfile: ["RUN echo hi"] } }));
    expect((await loadConfig(dir)).sandbox).toMatchObject({ image: "ghcr.io/me/img:1", dockerfile: ["RUN echo hi"] });
  });

  it("rejects FROM lines, bad images, unknown keys and small limits", async () => {
    await write(JSON.stringify({ sandbox: { dockerfile: ["RUN a", "FROM node:20"] } }));
    await expect(loadConfig(dir)).rejects.toThrow(
      /sandbox\.dockerfile\.1: FROM is not allowed in sandbox Dockerfile lines; use COPY --from=<image>/,
    );
    for (const sandbox of [{ base: "not an image" }, { cpu: 2 }, { memoryMb: 100 }, { pids: 10 }, { env: ["1BAD"] }]) {
      await write(JSON.stringify({ sandbox }));
      await expect(loadConfig(dir)).rejects.toBeInstanceOf(ConfigError);
    }
  });
});
