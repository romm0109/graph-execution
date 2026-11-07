// @ts-check
// A small, safe markdown renderer: everything is escaped first, then only whitelisted constructs are added.

/** @param {string} s */
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/**
 * Same rule as `parseSuggestion` in src/review/human.ts: the replacement text of the first suggestion block.
 * @param {string} body
 * @returns {string | undefined}
 */
export function parseSuggestion(body) {
  const m = /^```suggestion[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m.exec(body);
  if (!m) return undefined;
  return (m[1] ?? "").replace(/\r?\n$/, "");
}

/**
 * Old lines (`-`) and new lines (`+`) of a suggestion. Snippet lines marked `-` are old-side rows and are left out.
 * @param {string | undefined} snippet
 * @param {string} suggestion
 * @returns {{ del: string[], add: string[] }}
 */
export function suggestionDiff(snippet, suggestion) {
  const del = (snippet ? snippet.split("\n") : []).filter((l) => !l.startsWith("-")).map((l) => (l.startsWith("+") ? l.slice(1) : l));
  return { del, add: suggestion === "" ? [] : suggestion.split("\n") };
}

/** Inline formatting on escaped text; code spans first so nothing runs inside them. @param {string} t */
function inline(t) {
  return t
    .split(/(`[^`\n]+`)/)
    .map((part, i) => {
      if (i % 2) return "<code>" + part.slice(1, -1) + "</code>";
      return part
        .split(/(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/)
        .map((seg, j) => {
          if (j % 2) {
            const m = /^\[([^\]]+)\]\((.+)\)$/.exec(seg);
            if (m) return `<a href="${m[2]}" target="_blank" rel="noopener noreferrer">${emphasis(m[1] ?? "")}</a>`;
          }
          return emphasis(seg);
        })
        .join("");
    })
    .join("");
}

/** @param {string} t */
function emphasis(t) {
  return t
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
}

/** @param {string} block */
function paragraphs(block) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  let text = [];
  /** @type {{ tag: "ul" | "ol", items: string[] } | null} */
  let list = null;
  const flushText = () => {
    if (text.length) out.push("<p>" + text.join("<br>") + "</p>");
    text = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>` + list.items.map((i) => "<li>" + i + "</li>").join("") + `</${list.tag}>`);
    list = null;
  };
  for (const raw of block.split(/\r?\n/)) {
    if (raw.trim() === "") {
      flushText();
      flushList();
      continue;
    }
    const li = /^[-*] (.*)$/.exec(raw);
    const ol = /^\d+\. (.*)$/.exec(raw);
    const m = li ?? ol;
    if (m) {
      const tag = li ? "ul" : "ol";
      flushText();
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(inline(esc(m[1] ?? "")));
    } else {
      flushList();
      text.push(inline(esc(raw)));
    }
  }
  flushText();
  flushList();
  return out.join("");
}

/** @param {string} snippet @param {string} suggestion */
function suggestionHtml(snippet, suggestion) {
  const { del, add } = suggestionDiff(snippet, suggestion);
  const line = (/** @type {string} */ cls, /** @type {string} */ mark, /** @type {string} */ t) => `<div class="${cls}"><span class="mk">${mark}</span>${esc(t)}</div>`;
  return '<div class="sugg"><div class="sugg-head">Suggested change</div>' + del.map((l) => line("sd", "-", l)).join("") + add.map((l) => line("sa", "+", l)).join("") + "</div>";
}

/**
 * @param {string} text
 * @param {{ snippet?: string }} [opts]
 * @returns {string} HTML, safe to assign to innerHTML
 */
export function renderMarkdown(text, { snippet } = {}) {
  const lines = String(text ?? "").split("\n");
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  let buf = [];
  const flush = () => {
    if (buf.length) out.push(paragraphs(buf.join("\n")));
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = /^```([^\s`]*)[ \t]*\r?$/.exec(lines[i] ?? "");
    if (open) {
      let end = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^```[ \t]*\r?$/.test(lines[j] ?? "")) {
          end = j;
          break;
        }
      }
      if (end >= 0) {
        flush();
        const body = lines.slice(i + 1, end).map((l) => l.replace(/\r$/, "")).join("\n");
        out.push(open[1] === "suggestion" ? suggestionHtml(snippet ?? "", body) : `<pre><code>${esc(body)}</code></pre>`);
        i = end;
        continue;
      }
    }
    buf.push(lines[i] ?? "");
  }
  flush();
  return out.join("");
}
