// Notices for the signed-in user (e.g. a session the idle loop closed, sessions/idle.ts). Each is returned once.
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import type { Data } from "../store.js";

export async function noticeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/notices", async (req) => {
    const us = await ctx.store.forUser(req.user);
    if (us.get().notices.length === 0) return { notices: [] };
    let notices: Data["notices"] = [];
    await us.update((d) => {
      notices = d.notices;
      d.notices = [];
    });
    return { notices };
  });
}
