import { createServer, type Server } from "node:net";

const listenOnFreePort = (): Promise<{ server: Server; port: number }> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });

const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

/** `n` distinct ports that were free a moment ago: the OS picks them, the probe servers stay open until all are picked, then close. */
export async function freePorts(n: number): Promise<number[]> {
  const probes: { server: Server; port: number }[] = [];
  try {
    for (let i = 0; i < n; i++) probes.push(await listenOnFreePort());
    return probes.map((p) => p.port);
  } finally {
    await Promise.all(probes.map((p) => close(p.server)));
  }
}
