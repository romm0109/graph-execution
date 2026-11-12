import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { delegateTarget, runDelegate } from "./delegate.js";

let dir: string;
let delegate: string;
let self: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ge-delegate-"));
  delegate = path.join(dir, "shim.js");
  self = path.join(dir, "cli.js");
  await writeFile(delegate, "process.exitCode = process.env.GRAPH_EXECUTION_DELEGATED === '1' ? Number(process.argv[2]) : 99;");
  await writeFile(self, "");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("delegateTarget", () => {
  it("delegates to an existing .js file when this engine is not GM_ENGINE_BIN", () => {
    expect(delegateTarget({ GRAPH_EXECUTION_DELEGATE: delegate }, self)).toBe(delegate);
    expect(delegateTarget({ GRAPH_EXECUTION_DELEGATE: delegate, GM_ENGINE_BIN: path.join(dir, "other.js") }, self)).toBe(delegate);
  });

  it("runs in place without a delegate, a missing or non-.js one, or when already delegated", () => {
    expect(delegateTarget({}, self)).toBeUndefined();
    expect(delegateTarget({ GRAPH_EXECUTION_DELEGATE: path.join(dir, "missing.js") }, self)).toBeUndefined();
    expect(delegateTarget({ GRAPH_EXECUTION_DELEGATE: dir }, self)).toBeUndefined();
    expect(delegateTarget({ GRAPH_EXECUTION_DELEGATE: delegate, GRAPH_EXECUTION_DELEGATED: "1" }, self)).toBeUndefined();
  });

  it("runs in place when this engine is GM_ENGINE_BIN, through a symlink too", async () => {
    expect(delegateTarget({ GRAPH_EXECUTION_DELEGATE: delegate, GM_ENGINE_BIN: self }, self)).toBeUndefined();
    const link = path.join(dir, "link.js");
    try {
      await symlink(self, link);
    } catch {
      return; // no symlinks (Windows without the privilege)
    }
    expect(delegateTarget({ GRAPH_EXECUTION_DELEGATE: delegate, GM_ENGINE_BIN: link }, self)).toBeUndefined();
  });
});

describe("runDelegate", () => {
  it("runs the target with GRAPH_EXECUTION_DELEGATED=1 and returns its exit code", async () => {
    expect(await runDelegate(delegate, ["7"])).toBe(7);
  });
});
