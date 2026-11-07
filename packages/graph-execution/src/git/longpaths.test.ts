import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { longPathsEnv } from "./longpaths.js";

describe("longPathsEnv", () => {
  it.each(["darwin", "linux"] as const)("adds nothing on %s", (platform) => {
    expect(longPathsEnv({}, platform)).toEqual({});
  });

  it("turns core.longpaths on through git's config environment on Windows", () => {
    expect(longPathsEnv({}, "win32")).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.longpaths",
      GIT_CONFIG_VALUE_0: "true",
    });
  });

  it("appends after config pairs already in the environment", () => {
    const env = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "1", GIT_CONFIG_KEY_1: "c.d" };
    expect(longPathsEnv(env, "win32")).toEqual({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "core.longpaths",
      GIT_CONFIG_VALUE_2: "true",
    });
  });

  it("leaves a core.longpaths already in the environment alone", () => {
    const env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.longPaths", GIT_CONFIG_VALUE_0: "false" };
    expect(longPathsEnv(env, "win32")).toEqual({});
  });

  it("treats an invalid count as none", () => {
    expect(longPathsEnv({ GIT_CONFIG_COUNT: "x" }, "win32")).toMatchObject({ GIT_CONFIG_COUNT: "1" });
  });

  it("is read by git", async () => {
    // git honours these variables on every platform, so this checks the real effect wherever the tests run.
    const res = await execa("git", ["config", "--get", "core.longpaths"], {
      env: longPathsEnv({}, "win32"),
      reject: false,
    });
    expect(res.stdout.trim()).toBe("true");
  });
});
