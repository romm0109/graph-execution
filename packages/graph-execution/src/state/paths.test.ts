import { describe, expect, it } from "vitest";
import { RUN_ENV_UNSET } from "./paths.js";

describe("RUN_ENV_UNSET", () => {
  it("unsets the internal sandbox, web page and lock variables (KAN-88)", () => {
    expect(Object.keys(RUN_ENV_UNSET)).toEqual(
      expect.arrayContaining([
        "GRAPH_EXECUTION_SANDBOX",
        "GRAPH_EXECUTION_SANDBOX_IMAGE",
        "GRAPH_EXECUTION_WEB_HOST",
        "GRAPH_EXECUTION_WEB_PORT",
        "GRAPH_EXECUTION_WEB_TOKEN",
        "GRAPH_EXECUTION_TAKE_LOCK_FROM",
      ]),
    );
  });
});
