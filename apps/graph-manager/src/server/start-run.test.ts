import { describe, expect, it } from "vitest";
import { engineEnv } from "./start-run.js";

describe("engineEnv", () => {
  it("drops graph-manager's secrets and internal variables, keeps the rest", () => {
    const env = engineEnv(
      { PATH: "/bin", GM_PASSWORD: "pw", GM_EXTENSION_SECRET: "s3cret", GRAPH_EXECUTION_RUNS_ROOT: "/x", HOME: "/h" },
      { EXTRA: "1" },
    );
    expect(env.GM_PASSWORD).toBeUndefined();
    expect(env.GM_EXTENSION_SECRET).toBeUndefined();
    expect(env.GRAPH_EXECUTION_RUNS_ROOT).toBeUndefined();
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/h", EXTRA: "1", GRAPH_EXECUTION_HANDOFF: "detached", SSH_CONNECTION: "1" });
  });
});
