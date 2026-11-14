import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";

/** The UI plugin modules (`GM_UI_PLUGINS`) the web UI imports after sign-in. Behind login like every `/api/*` path. */
export async function uiRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/ui/plugins", async () => ({ plugins: ctx.config.uiPlugins ?? [] }));
}
