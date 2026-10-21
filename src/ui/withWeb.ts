import { startWebUi } from "../web/start.js";
import type { UiHandle, UiOptions } from "./start.js";

type UiFactory = (opts: UiOptions) => UiHandle | Promise<UiHandle>;

/** Runs the terminal UI and an in-process web server on the same events and hub, for human review without --web. */
export function withWebUi(terminal: UiFactory, onUrl?: (url: string) => void): UiFactory {
  return async (o) => {
    // The server starts first so the terminal UI knows the URL; a failure here must not skip the review silently.
    const web = await startWebUi(o);
    const url = web.url;
    onUrl?.(url);
    let term: UiHandle;
    try {
      term = await terminal({ ...o, reviewUrl: url });
    } catch (err) {
      await web.close();
      throw err;
    }
    const log = (line: string): void => {
      term.log(line);
      web.log(line);
    };
    term.log(`web view: ${url}`);
    web.log(`web view: ${url}`);
    const off = o.events.on("review:waiting", () => log(`waiting for your review: ${url}`));
    return {
      log,
      stop: async () => {
        off();
        await term.stop();
        await web.close();
      },
    };
  };
}
