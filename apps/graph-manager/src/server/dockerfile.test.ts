import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The image is not built here: this pins how it builds and starts graph-manager.
const lines = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8").split(/\r?\n/);

describe("Dockerfile", () => {
  it("starts graph-manager through the engine CLI, without opening a browser", () => {
    expect(lines.filter((l) => l.startsWith("CMD ")).at(-1)).toBe('CMD ["node", "/app/packages/graph-execution/dist/cli.js", "manager", "--no-open"]');
    expect(lines.some((l) => l.includes("dist/server/main.js"))).toBe(false);
  });

  it("builds with the root build, which bundles the manager into the engine", () => {
    expect(lines.some((l) => l.startsWith("RUN ") && l.includes("npm run build && npm prune --omit=dev"))).toBe(true);
  });
});
