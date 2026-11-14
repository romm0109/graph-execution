import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

/**
 * A plain-HTTP server on 127.0.0.1 (random port) that hands `/api/internal/*` requests to the app's router and answers
 * every other path 404. Used when graph-manager serves HTTPS: the terminals' tools (shim.ts, mcp.ts) call
 * GM_INTERNAL_URL with Node's fetch, which can't skip certificate checks on loopback. The app must be ready.
 */
export async function startInternalListener(app: FastifyInstance): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (!(req.url ?? "").startsWith("/api/internal/")) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    app.routing(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
