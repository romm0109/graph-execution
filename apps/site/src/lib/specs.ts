import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ShippedSpec {
  file: string;
  title: string;
  url: string;
}

const BLOB = "https://github.com/romm0109/graph-execution/blob/main/docs/prd/done/";

/** The specs in `dir` (docs/prd/done), titled by their first `# ` heading. */
export function loadShippedSpecs(dir: string): ShippedSpec[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => {
      const heading = readFileSync(join(dir, file), "utf8")
        .split(/\r?\n/)
        .find((line) => line.startsWith("# "));
      const title = heading
        ? heading.slice(2).replace(/^PRD:\s*/, "").replace(/`/g, "").trim()
        : file.replace(/\.md$/, "");
      return { file, title, url: BLOB + encodeURIComponent(file) };
    });
}
