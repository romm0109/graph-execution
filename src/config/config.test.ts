import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_FILE, ConfigError, loadConfig } from "./config.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "graph-execution-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (content: string): Promise<void> => writeFile(path.join(dir, CONFIG_FILE), content);

describe("loadConfig", () => {
  it("returns the defaults when the file is absent", async () => {
    expect(await loadConfig(dir)).toEqual({
      setup: [],
      validate: [],
      validateParallel: false,
      attempts: 3,
      validationRounds: 3,
      fixPasses: 3,
    });
  });

  it("reads the given keys and fills in the rest", async () => {
    await write(
      JSON.stringify({ setup: ["npm ci"], validate: ["npm test"], validateParallel: true, concurrency: 5, validationRounds: 1 }),
    );
    expect(await loadConfig(dir)).toEqual({
      setup: ["npm ci"],
      validate: ["npm test"],
      validateParallel: true,
      concurrency: 5,
      attempts: 3,
      validationRounds: 1,
      fixPasses: 3,
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
