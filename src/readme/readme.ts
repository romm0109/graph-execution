import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execa } from "execa";

/** The README shipped with the package, next to `dist/`. */
export const README_MD = fileURLToPath(new URL("../../README.md", import.meta.url));
/** The README rendered by `npm run build` (scripts/render-readme.mjs). */
export const README_HTML = fileURLToPath(new URL("../README.html", import.meta.url));

export class ReadmeError extends Error {}

/** The command that opens a file in the default browser on `platform`. */
export function openCommand(file: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === "darwin") return ["open", [file]];
  // `start` is a cmd builtin; its first quoted argument is the window title, left empty.
  if (platform === "win32") return ["cmd", ["/c", "start", "", file]];
  return ["xdg-open", [file]];
}

export interface ShowReadmeOptions {
  /** Writes the raw markdown to stdout instead of opening the browser. */
  print?: boolean;
  out?: (text: string) => void;
  /** Opens `file`; resolves false when no browser could be opened. */
  open?: (file: string) => Promise<boolean>;
  html?: string;
  markdown?: string;
}

/** Opens a file or URL in the default browser; false when that failed. */
export async function openInBrowser(file: string): Promise<boolean> {
  const [command, args] = openCommand(file);
  const result = await execa(command, args, { reject: false, stdio: "ignore" });
  return result.exitCode === 0 && !result.failed;
}

/**
 * `graph-execution readme`: opens the rendered README in the default browser, or prints where it is when none can be
 * opened (SSH, CI). `--print` writes the markdown itself to stdout, for a pager.
 */
export async function showReadme(opts: ShowReadmeOptions = {}): Promise<void> {
  const out = opts.out ?? ((text: string) => process.stdout.write(text));
  const markdown = opts.markdown ?? README_MD;
  const html = opts.html ?? README_HTML;
  if (opts.print) {
    out(await readFile(markdown, "utf8"));
    return;
  }
  if (!existsSync(html)) {
    throw new ReadmeError(`the rendered README is missing (${html}); run \`npm run build\`, or use --print`);
  }
  if (await (opts.open ?? openInBrowser)(html)) {
    out(`Opened the README in your browser: ${pathToFileURL(html).href}\n`);
  } else {
    out(`Could not open a browser. Open this file to read the README: ${pathToFileURL(html).href}\n`);
    out("Or print it here with: graph-execution readme --print\n");
  }
}
