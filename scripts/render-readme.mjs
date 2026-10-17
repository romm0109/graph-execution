// Renders README.md to dist/README.html for `graph-execution readme`; run by `npm run build`.
import { readFileSync, writeFileSync } from "node:fs";
import { Marked } from "marked";

const [source = "README.md", target = "dist/README.html"] = process.argv.slice(2);

/** GitHub's heading anchors, so the README's own `#section` links work. */
const slugs = new Map();
function slug(text) {
  const base = text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
  const seen = slugs.get(base) ?? 0;
  slugs.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen}`;
}

const marked = new Marked({
  gfm: true,
  renderer: {
    heading({ tokens, depth, text }) {
      return `<h${depth} id="${slug(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
  },
});

const markdown = readFileSync(source, "utf8");
const title = markdown.match(/^# (.+)$/m)?.[1] ?? "README";

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root {
  --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --border: #d1d9e0; --code-bg: #f6f8fa; --link: #0969da;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --border: #3d444d; --code-bg: #151b23; --link: #4493f8; }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}
main { max-width: 880px; margin: 0 auto; padding: 32px 16px 64px; }
h1, h2 { border-bottom: 1px solid var(--border); padding-bottom: .3em; }
h1, h2, h3 { line-height: 1.25; margin: 1.5em 0 .6em; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre { font: 85% ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
code { background: var(--code-bg); padding: .2em .4em; border-radius: 6px; }
pre { background: var(--code-bg); padding: 16px; border-radius: 6px; overflow-x: auto; line-height: 1.45; }
pre code { background: none; padding: 0; font-size: 100%; }
table { border-collapse: collapse; display: block; overflow-x: auto; margin: 1em 0; }
th, td { border: 1px solid var(--border); padding: 6px 13px; text-align: left; vertical-align: top; }
th { background: var(--code-bg); }
blockquote { margin: 0; padding: 0 1em; color: var(--muted); border-left: .25em solid var(--border); }
</style>
</head>
<body>
<main>
${marked.parse(markdown)}
</main>
</body>
</html>
`;

writeFileSync(target, html);
