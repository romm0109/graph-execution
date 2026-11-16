import { describe, expect, it, vi } from "vitest";
import { resolvePath, type Exec } from "./shellEnv.js";

describe("resolvePath", () => {
  it("takes the PATH from the marker line of noisy shell output", async () => {
    const exec = vi.fn<Exec>(async () => "motd\n\n__GM_PATH__/a:/b\n");
    const got = await resolvePath({ platform: "darwin", env: { PATH: "/usr/bin", SHELL: "/bin/bash" }, home: "/home/u", exec });
    expect(got).toBe("/a:/b");
    expect(exec.mock.calls[0]?.[0]).toBe("/bin/bash");
    expect(exec.mock.calls[0]?.[1][0]).toBe("-ilc");
  });

  it("falls back to env PATH plus the usual dirs when the shell fails", async () => {
    const log = vi.fn();
    const exec: Exec = async () => {
      throw new Error("timed out");
    };
    const got = await resolvePath({ platform: "darwin", env: { PATH: "/usr/bin" }, home: "/home/u", exec, log });
    expect(got).toBe("/usr/bin:/opt/homebrew/bin:/usr/local/bin:/home/u/.local/bin");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("shell PATH failed"));
  });

  it("falls back when the output has no marker, without duplicating dirs", async () => {
    const log = vi.fn();
    const got = await resolvePath({ platform: "darwin", env: { PATH: "/usr/local/bin:/usr/bin" }, home: "/h", exec: async () => "nothing", log });
    expect(got).toBe("/usr/local/bin:/usr/bin:/opt/homebrew/bin:/h/.local/bin");
    expect(log).toHaveBeenCalled();
  });

  it("returns env PATH unchanged off macOS without running a shell", async () => {
    const exec = vi.fn<Exec>(async () => "");
    expect(await resolvePath({ platform: "linux", env: { PATH: "/x:/y" }, home: "/h", exec })).toBe("/x:/y");
    expect(exec).not.toHaveBeenCalled();
  });
});
