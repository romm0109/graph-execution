import { readFileSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { needsAuth } from "./auth.js";
import { tempDir, testConfig } from "./test-helpers.js";

const publicUrl = new URL("../web/public/", import.meta.url);
const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

/** Width and height from a PNG's IHDR chunk. */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("installable app: committed files", () => {
  it("has the manifest", () => {
    const manifest: unknown = JSON.parse(readFileSync(new URL("manifest.webmanifest", publicUrl), "utf8"));
    expect(manifest).toEqual({
      name: "graph-manager",
      short_name: "graph-manager",
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#0e0f11",
      theme_color: "#16181b",
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    });
  });

  it.each([
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["icon-maskable-512.png", 512],
  ])("has icons/%s at %i px", (file, size) => {
    expect(pngSize(readFileSync(new URL(`icons/${file}`, publicUrl)))).toEqual({ width: size, height: size });
  });

  it("links the manifest and the Apple tags from index.html", () => {
    for (const tag of [
      '<link rel="manifest" href="/manifest.webmanifest" />',
      '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />',
      '<meta name="mobile-web-app-capable" content="yes" />',
      '<meta name="apple-mobile-web-app-capable" content="yes" />',
      '<meta name="apple-mobile-web-app-title" content="graph-manager" />',
      '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
    ])
      expect(html).toContain(tag);
  });
});

describe("installable app: server", () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    let dir: string;
    ({ dir, cleanup } = await tempDir());
    const webDir = path.join(dir, "web");
    await mkdir(path.join(webDir, "icons"), { recursive: true });
    await writeFile(path.join(webDir, "index.html"), "<!doctype html><title>gm</title>");
    await writeFile(path.join(webDir, "app.js"), "console.log(1)");
    await writeFile(path.join(webDir, "sw.js"), 'self.addEventListener("fetch", () => {})');
    await writeFile(path.join(webDir, "manifest.webmanifest"), "{}");
    await copyFile(fileURLToPath(new URL("icons/icon-192.png", publicUrl)), path.join(webDir, "icons", "icon-192.png"));
    app = await buildApp(testConfig(dir), { webDir, viewCache: false });
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("serves the manifest as application/manifest+json without a cookie", async () => {
    const res = await app.inject({ url: "/manifest.webmanifest" });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/^application\/manifest\+json/);
    expect(needsAuth("GET", "/manifest.webmanifest")).toBe(false);
  });

  it("serves sw.js with cache-control: no-cache without a cookie", async () => {
    const res = await app.inject({ url: "/sw.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(needsAuth("GET", "/sw.js")).toBe(false);
  });

  it("serves the icons without a cookie", async () => {
    const res = await app.inject({ url: "/icons/icon-192.png" });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/^image\/png/);
    expect(needsAuth("GET", "/icons/icon-192.png")).toBe(false);
  });

  it("keeps the default headers of other files", async () => {
    const res = await app.inject({ url: "/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=0");
  });
});
