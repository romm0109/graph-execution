#!/usr/bin/env node
// Portable `timeout <secs> cmd...` (macOS has none). Exits 124 on timeout, like GNU timeout.
import { spawn } from "node:child_process";
const [secs, ...cmd] = process.argv.slice(2);
const c = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", detached: true });
const t = setTimeout(() => { try { process.kill(-c.pid, "SIGKILL"); } catch {} process.exit(124); }, Number(secs) * 1000);
c.on("exit", (code) => { clearTimeout(t); try { process.kill(-c.pid, "SIGKILL"); } catch {} process.exit(code ?? 1); });
