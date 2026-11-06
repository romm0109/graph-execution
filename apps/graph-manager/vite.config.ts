import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI is built into dist/web, which the server serves with @fastify/static.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": { target: "http://127.0.0.1:7420", ws: true }, "/runs": "http://127.0.0.1:7420" } },
});
