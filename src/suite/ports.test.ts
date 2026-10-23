import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { freePorts } from "./ports.js";

describe("freePorts", () => {
  it("returns distinct ports a server can listen on afterwards", async () => {
    const ports = await freePorts(3);
    expect(new Set(ports).size).toBe(3);
    for (const port of ports) {
      expect(port).toBeGreaterThan(0);
      await new Promise<void>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
      });
    }
  });
});
