import { describe, expect, it } from "vitest";
import * as docker from "./docker.js";
import type { Exec, ExecOptions, ExecResult } from "./docker.js";

function fakeExec(answer: (args: string[]) => Partial<ExecResult> = () => ({})) {
  const calls: { args: string[]; opts?: ExecOptions }[] = [];
  const exec: Exec = async (args, opts) => {
    calls.push({ args, ...(opts ? { opts } : {}) });
    return { exitCode: 0, stdout: "", stderr: "", ...answer(args) };
  };
  return { exec, calls };
}

describe("docker CLI wrapper", () => {
  it("builds with the Dockerfile on stdin and streams lines", async () => {
    const { exec, calls } = fakeExec();
    const onLine = (): void => undefined;
    await docker.build("FROM x\n", "t:1", { exec, onLine });
    expect(calls[0]!.args).toEqual(["build", "-t", "t:1", "-"]);
    expect(calls[0]!.opts?.input).toBe("FROM x\n");
    expect(calls[0]!.opts?.onLine).toBe(onLine);
    await docker.build("FROM x\n", "t:1", { exec, noCache: true });
    expect(calls[1]!.args).toEqual(["build", "-t", "t:1", "--no-cache", "--pull", "-"]);
  });

  it("builds argv for the container calls", async () => {
    const { exec, calls } = fakeExec((args) => (args[0] === "port" ? { stdout: "127.0.0.1:41234\n" } : { stdout: "abc\n" }));
    expect(await docker.create(["--name", "c", "img"], { exec })).toBe("abc");
    await docker.cp("/tmp/x/.", "c", "/home/sandbox", { exec, archive: true });
    await docker.start("c", { exec });
    expect(await docker.port("c", "7600/tcp", { exec })).toBe(41234);
    await docker.rm("c", { exec, force: true });
    await docker.pull("img", { exec });
    expect(calls.map((c) => c.args)).toEqual([
      ["create", "--name", "c", "img"],
      ["cp", "-a", "/tmp/x/.", "c:/home/sandbox"],
      ["start", "c"],
      ["port", "c", "7600/tcp"],
      ["rm", "-f", "c"],
      ["pull", "img"],
    ]);
  });

  it("reads image existence, PATH, state and logs", async () => {
    const { exec } = fakeExec((args) => {
      if (args[0] === "image" && args.at(-1) === "missing") return { exitCode: 1, stderr: "No such image" };
      if (args[0] === "image") return { stdout: '["PATH=/usr/local/bin:/usr/bin","NODE_VERSION=24"]\n' };
      if (args[0] === "container" && args.at(-1) === "gone") return { exitCode: 1, stderr: "Error: No such container: gone" };
      if (args[0] === "container") return { stdout: '{"Status":"running","Running":true,"ExitCode":0}' };
      if (args[0] === "logs") return { stdout: "out", stderr: "err" };
      return {};
    });
    expect(await docker.imageExists("missing", { exec })).toBe(false);
    expect(await docker.imageExists("img", { exec })).toBe(true);
    expect(await docker.imagePath("img", { exec })).toBe("/usr/local/bin:/usr/bin");
    expect(await docker.inspect("gone", { exec })).toBeUndefined();
    expect(await docker.inspect("c", { exec })).toEqual({ status: "running", running: true, exitCode: 0 });
    expect(await docker.logs("c", { exec })).toBe("out\nerr");
    expect(await docker.dockerAvailable({ exec })).toBe(true);
  });

  it("wraps errors with the command's stderr", async () => {
    const { exec } = fakeExec(() => ({ exitCode: 1, stderr: "Cannot connect to the Docker daemon" }));
    await expect(docker.start("c", { exec })).rejects.toThrow(/docker start c failed \(exit 1\): Cannot connect to the Docker daemon/);
    await expect(docker.inspect("c", { exec })).rejects.toBeInstanceOf(docker.DockerError);
    expect(await docker.dockerAvailable({ exec })).toBe(false);
  });
});
