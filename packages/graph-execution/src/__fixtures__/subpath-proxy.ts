import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A reverse proxy on 127.0.0.1 that serves `http://127.0.0.1:<target>/<rest>` at `/<prefix>/<rest>`, the way
 * graph-manager serves a run's page under a sub-path. It sets Host to the target and drops Origin.
 */
export async function startPrefixProxy(targetPort: number, prefix: string): Promise<{ base: string; close: () => Promise<void> }> {
  const pre = "/" + prefix.replace(/^\/+|\/+$/g, "") + "/";
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (!url.startsWith(pre)) {
      res.writeHead(404).end();
      return;
    }
    const headers = { ...req.headers, host: `127.0.0.1:${targetPort}` };
    delete headers.origin;
    const up = http.request({ host: "127.0.0.1", port: targetPort, method: req.method, path: "/" + url.slice(pre.length), headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.writeHead(502).end());
    req.pipe(up);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}${pre}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The static URLs a page, module or stylesheet refers to: `href`/`src`, module imports and `url(...)`. */
function references(text: string, type: string): string[] {
  const found: string[] = [];
  const patterns = type.includes("html")
    ? [/\b(?:href|src)="([^"]+)"/g]
    : type.includes("css")
      ? [/\burl\("([^"]+)"\)/g]
      : [/^import\b[^"\n]*?\bfrom\s+"([^"]+)"/gm, /\bimport\(\s*"([^"]+)"\s*\)/g];
  for (const re of patterns) for (const m of text.matchAll(re)) found.push(m[1]!);
  return found;
}

/**
 * Loads the page at `pageUrl` and every page-local file it refers to, recursively, resolving each reference against
 * the file that holds it, as a browser does. Returns `url -> status` of every file it fetched.
 */
export async function crawl(pageUrl: string): Promise<Map<string, number>> {
  const origin = new URL(pageUrl).origin;
  const seen = new Map<string, number>();
  const queue = [pageUrl];
  while (queue.length) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    const res = await fetch(url);
    seen.set(url, res.status);
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/html|javascript|css/.test(type)) {
      await res.body?.cancel();
      continue;
    }
    for (const ref of references(await res.text(), type)) {
      const next = new URL(ref, url);
      if (next.origin === origin) queue.push(next.href.replace(/#.*$/, ""));
    }
  }
  return seen;
}
