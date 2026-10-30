import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_FILE,
  ConfigError,
  configSchema,
  loadConfig,
} from "./config.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "graph-execution-config-"));
});
afterEach(async () => {
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});

const write = (content: string): Promise<void> =>
  writeFile(path.join(dir, CONFIG_FILE), content);

describe("loadConfig", () => {
  it("returns the defaults when the file is absent", async () => {
    expect(await loadConfig(dir)).toEqual({
      setup: [],
      validate: [],
      validateParallel: false,
      validateAt: "task",
      attempts: 3,
      idleTimeoutMinutes: 10,
      validationRounds: 3,
      fixPasses: 3,
      humanReview: false,
      keepRuns: 5,
      e2eReview: true,
      loopDetection: { repeats: 5 },
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

  it("accepts keepRuns 0 and rejects negative values", async () => {
    await write(JSON.stringify({ keepRuns: 0 }));
    expect((await loadConfig(dir)).keepRuns).toBe(0);
    await write(JSON.stringify({ keepRuns: -1 }));
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
      JSON.stringify({
        setup: ["npm ci"],
        validate: ["npm test"],
        validateParallel: true,
        concurrency: 5,
        validationRounds: 1,
      }),
    );
    expect(await loadConfig(dir)).toEqual({
      setup: ["npm ci"],
      validate: ["npm test"],
      validateParallel: true,
      validateAt: "task",
      concurrency: 5,
      attempts: 3,
      idleTimeoutMinutes: 10,
      validationRounds: 1,
      fixPasses: 3,
      humanReview: false,
      keepRuns: 5,
      e2eReview: true,
      loopDetection: { repeats: 5 },
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
    await expect(loadConfig(dir)).rejects.toThrow(
      /concurrency[\s\S]*setup|setup[\s\S]*concurrency/,
    );
  });

  it("reports invalid JSON with the file path", async () => {
    await write("{ setup: ");
    await expect(loadConfig(dir)).rejects.toThrow(
      `invalid JSON in ${path.join(dir, CONFIG_FILE)}`,
    );
  });
});

describe("model and idleTimeoutMinutes", () => {
  it("reads model and a fractional idle timeout, and rejects an empty model", () => {
    expect(
      configSchema.parse({ model: "qwen/qwen3-27b", idleTimeoutMinutes: 0.5 }),
    ).toMatchObject({
      model: "qwen/qwen3-27b",
      idleTimeoutMinutes: 0.5,
    });
    expect(() => configSchema.parse({ model: "" })).toThrow();
    expect(() => configSchema.parse({ idleTimeoutMinutes: -1 })).toThrow();
  });
});
