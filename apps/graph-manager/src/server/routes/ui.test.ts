import { afterEach, describe, expect, it } from "vitest";
import { appWithLogin } from "../test-helpers.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("GET /api/ui/plugins", () => {
  it("lists the configured plugins behind login", async () => {
    const t = await appWithLogin({ uiPlugins: ["/plugins/hello.js", "https://cdn.example.com/p.js"] });
    cleanup = t.cleanup;
    const res = await t.app.inject({ url: "/api/ui/plugins", headers: { cookie: t.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plugins: ["/plugins/hello.js", "https://cdn.example.com/p.js"] });
    expect((await t.app.inject({ url: "/api/ui/plugins" })).statusCode).toBe(401);
  });

  it("answers an empty list when none are configured", async () => {
    const t = await appWithLogin();
    cleanup = t.cleanup;
    const res = await t.app.inject({ url: "/api/ui/plugins", headers: { cookie: t.cookie } });
    expect(res.json()).toEqual({ plugins: [] });
  });
});
