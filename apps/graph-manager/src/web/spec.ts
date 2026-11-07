/*
 * Pure helpers for the spec view: Markdown → safe HTML (raw HTML escaped, unsafe links dropped) and the mermaid
 * block sources, so SpecView can render block i from source i without reading it back from the DOM.
 */
import { Marked, type Token, type Tokens } from "marked";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const escapeAttr = escapeHtml;

/** Keeps http(s), in-page anchors and relative paths; anything else with a scheme (javascript:, data:, …) is dropped. */
export function safeHref(href: string): string | undefined {
  const h = href.trim();
  if (h === "") return undefined;
  if (h.startsWith("#")) return h;
  if (/^https?:/i.test(h)) return h;
  // Relative: no ":" before the first "/", "?" or "#". Control characters are rejected outright.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(h)) return undefined;
  const end = h.search(/[/?#]/);
  const head = end === -1 ? h : h.slice(0, end);
  return head.includes(":") ? undefined : h;
}

function isHttp(href: string): boolean {
  return /^https?:/i.test(href.trim());
}

let mermaidIndex = 0;

const md = new Marked({ gfm: true, breaks: false });
md.use({
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(token.text);
    },
    code(token: Tokens.Code): string {
      if (token.lang === "mermaid") {
        const i = mermaidIndex++;
        return `<div class="spec-mermaid" data-mermaid="${i}"><pre class="spec-mermaid-src">${escapeHtml(token.text)}</pre></div>\n`;
      }
      const lang = (token.lang ?? "").trim().split(/\s+/)[0] ?? "";
      const cls = lang ? ` class="language-${escapeAttr(lang)}"` : "";
      return `<pre><code${cls}>${escapeHtml(token.text)}</code></pre>\n`;
    },
    link(token: Tokens.Link): string {
      const text = this.parser.parseInline(token.tokens);
      const href = safeHref(token.href);
      if (href === undefined) return text;
      const title = token.title ? ` title="${escapeAttr(token.title)}"` : "";
      const ext = isHttp(href) ? ` target="_blank" rel="noopener noreferrer"` : "";
      return `<a href="${escapeAttr(href)}"${title}${ext}>${text}</a>`;
    },
    image(token: Tokens.Image): string {
      const src = safeHref(token.href);
      if (src === undefined || src.startsWith("#")) return escapeHtml(token.text);
      const title = token.title ? ` title="${escapeAttr(token.title)}"` : "";
      return `<img src="${escapeAttr(src)}" alt="${escapeAttr(token.text)}"${title} loading="lazy">`;
    },
  },
});

export function renderSpecHtml(text: string): string {
  mermaidIndex = 0;
  return md.parse(text, { async: false });
}

export function mermaidSources(text: string): string[] {
  const out: string[] = [];
  md.walkTokens(md.lexer(text), (t: Token) => {
    if (t.type === "code" && (t as Tokens.Code).lang === "mermaid") out.push((t as Tokens.Code).text);
  });
  return out;
}
