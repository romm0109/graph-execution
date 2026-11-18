import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { startWebUi } from "../web/start.js";
import { webJsonPath } from "../web/webjson.js";
import type { UiHandle, UiOptions } from "./start.js";

type UiFactory = (opts: UiOptions) => UiHandle | Promise<UiHandle>;

export interface WithWebOptions {
  /** Called with the page URL once the server listens. */
  onUrl?: (url: string) => void;
  /** No `web view: <url>` line at start: the URL is printed only when the run waits for the user. */
  quiet?: boolean;
}

/**
 * Runs the terminal UI and an in-process web server on the same events and hub, for human review and escalations
 * without --web. While the run lives, `web.json` names the page, so `graph-execution open` finds it.
 */
export function withWebUi(terminal: UiFactory, options: WithWebOptions = {}): UiFactory {
  return async (o) => {
    // The server starts first so the terminal UI knows the URL; a failure here must not skip the review silently.
    const web = await startWebUi(o);
    const url = web.url;
    options.onUrl?.(url);
    let term: UiHandle;
    try {
      term = await terminal({ ...o, reviewUrl: url });
    } catch (err) {
      await web.close();
      throw err;
    }
    // With a shared store (the run's view) both UIs show the same events: one of them adds the line.
    const log = (line: string): void => {
      term.log(line);
      if (!o.store) web.log(line);
    };
    if (!options.quiet) log(`web view: ${url}`);
    const runDir = o.runDir;
    if (runDir) {
      await writeFile(webJsonPath(runDir), JSON.stringify({ url, pid: process.pid, host: os.hostname() })).catch(() => undefined);
    }
    const offs = [
      o.events.on("review:waiting", () => log(`waiting for your review: ${url}`)),
      o.events.on("escalation:open", ({ id, node }) => log(`waiting for your decision on ${id} (${node === "fixer" ? "the fixer" : `task ${node}`}): ${url}`)),
    ];
    return {
      log,
      stop: async () => {
        for (const off of offs) off();
        await term.stop();
        await web.close();
        if (runDir) await rm(webJsonPath(runDir), { force: true });
      },
    };
  };
}
