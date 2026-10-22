// Diff viewer for the Changes tab and the review overlay: file tree, sticky file headers, unified/split, highlight.js colours.
import { parseFileDiff, renderDiff, renderSplit, isLarge, setCode } from "./diff.js";

/** @typedef {import("./diff.js").DiffLine} DiffLine */
/** @typedef {import("./diff.js").Hunk} Hunk */

export const SPLIT_MIN_WIDTH = 900;
export const HIGHLIGHT_MAX_LINES = 2000;
const MODE_KEY = "ge.diffMode";
export const EXPAND_STEP = 20;
export const EXPAND_ALL_MAX = 60;

/** First new-side line a hunk covers; a hunk that only deletes (newLines 0) sits after line `newStart`. @param {Hunk} h */
const firstNew = (h) => (h.newLines === 0 ? h.newStart + 1 : h.newStart);
/** @param {Hunk} h */
const firstOld = (h) => (h.oldLines === 0 ? h.oldStart + 1 : h.oldStart);
/** One past the last new-side line a hunk covers. @param {Hunk} h */
const endNew = (h) => firstNew(h) + h.newLines;

/**
 * Gaps around hunks, in new-side numbers: [{beforeHunk: i, from, to}]. `beforeHunk === hunks.length` is the gap below the last
 * hunk, whose `to` is `total` once known and Infinity before.
 * @param {Hunk[]} hunks @param {number} [total]
 * @returns {Array<{beforeHunk: number, from: number, to: number}>}
 */
export function gaps(hunks, total) {
  /** @type {Array<{beforeHunk: number, from: number, to: number}>} */
  const out = [];
  let from = 1;
  hunks.forEach((h, i) => {
    const to = firstNew(h) - 1;
    if (to >= from) out.push({ beforeHunk: i, from, to });
    from = endNew(h);
  });
  const to = total === undefined ? Infinity : total;
  if (to >= from) out.push({ beforeHunk: hunks.length, from, to });
  return out;
}

/**
 * Inserts fetched lines (new-side `from`...) as context lines, with old numbers shifted by the offset of the neighbouring
 * hunk, and merges hunks whose gap closed. Returns new hunks; the input is not changed.
 * @param {Hunk[]} hunks @param {number} from @param {string[]} lines
 * @returns {Hunk[]}
 */
export function expand(hunks, from, lines) {
  if (!lines.length) return hunks;
  const end = from + lines.length;
  const below = hunks.find((h) => firstNew(h) >= end);
  const above = [...hunks].reverse().find((h) => endNew(h) <= from);
  const offset = below ? firstOld(below) - firstNew(below) : above ? firstOld(above) + above.oldLines - endNew(above) : 0;
  /** @type {Hunk} */
  const added = {
    oldStart: from + offset, oldLines: lines.length, newStart: from, newLines: lines.length, header: "",
    lines: lines.map((text, i) => ({ kind: "ctx", old: from + i + offset, new: from + i, text })),
  };
  const sorted = [...hunks, added].sort((a, b) => firstNew(a) - firstNew(b) || (a === added ? -1 : 1));
  /** @type {Hunk[]} */
  const out = [];
  for (const h of sorted) {
    const prev = out[out.length - 1];
    if (prev && endNew(prev) === firstNew(h)) {
      out[out.length - 1] = {
        oldStart: prev.oldLines + h.oldLines ? firstOld(prev) : prev.oldStart, oldLines: prev.oldLines + h.oldLines,
        newStart: firstNew(prev), newLines: prev.newLines + h.newLines,
        header: prev.header || h.header, lines: [...prev.lines, ...h.lines],
      };
    } else out.push(h);
  }
  return out;
}

/** Pairs a hunk's lines into split rows: a deletion run followed by an addition run is zipped; context sits on both sides.
 * @param {Hunk} hunk
 * @returns {Array<{left?: DiffLine, right?: DiffLine}>} */
export function toSplitRows(hunk) {
  /** @type {Array<{left?: DiffLine, right?: DiffLine}>} */
  const out = [];
  const lines = hunk.lines;
  for (let i = 0; i < lines.length; ) {
    const l = /** @type {DiffLine} */ (lines[i]);
    if (l.kind === "ctx") { out.push({ left: l, right: l }); i++; continue; }
    /** @type {DiffLine[]} */ const dels = [];
    /** @type {DiffLine[]} */ const adds = [];
    while (i < lines.length && /** @type {DiffLine} */ (lines[i]).kind === "del") dels.push(/** @type {DiffLine} */ (lines[i++]));
    while (i < lines.length && /** @type {DiffLine} */ (lines[i]).kind === "add") adds.push(/** @type {DiffLine} */ (lines[i++]));
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      /** @type {{left?: DiffLine, right?: DiffLine}} */
      const pair = {};
      if (dels[k]) pair.left = dels[k];
      if (adds[k]) pair.right = adds[k];
      out.push(pair);
    }
  }
  return out;
}

/**
 * Highlights text with hljs and returns one HTML string per input line; spans open at a line break are closed there and reopened on the next line.
 * @param {{highlight: (code: string, o: {language: string, ignoreIllegals?: boolean}) => {value: string}}} hljs
 * @param {string} text
 * @param {string} lang
 * @returns {string[]}
 */
export function highlightLines(hljs, text, lang) {
  const html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  /** @type {string[]} */ const lines = [];
  /** @type {string[]} */ const open = [];
  let cur = "";
  for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (part === "\n") {
      lines.push(cur + "</span>".repeat(open.length));
      cur = open.join("");
    } else {
      if (part.startsWith("<span")) open.push(part);
      else if (part === "</span>") open.pop();
      cur += part;
    }
  }
  lines.push(cur + "</span>".repeat(open.length));
  return lines;
}

/**
 * Highlights a hunk's old side and new side each as a whole; returns HTML aligned with hunk.lines.
 * @param {Parameters<typeof highlightLines>[0]} hljs @param {Hunk} hunk @param {string} lang
 * @returns {string[]}
 */
export function highlightHunk(hljs, hunk, lang) {
  const side = (/** @type {"del"|"add"} */ skip) => {
    const ls = hunk.lines.filter((l) => l.kind !== skip);
    return { ls, html: ls.length ? highlightLines(hljs, ls.map((l) => l.text).join("\n"), lang) : [] };
  };
  const oldSide = side("add");
  const newSide = side("del");
  /** @type {Map<DiffLine, string>} */ const byLine = new Map();
  oldSide.ls.forEach((l, i) => { if (l.kind === "del") byLine.set(l, /** @type {string} */ (oldSide.html[i])); });
  newSide.ls.forEach((l, i) => byLine.set(l, /** @type {string} */ (newSide.html[i])));
  return hunk.lines.map((l) => byLine.get(l) ?? "");
}

const LANGS = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", py: "python", go: "go", rs: "rust", java: "java",
  css: "css", scss: "scss", html: "xml", htm: "xml", xml: "xml", svg: "xml",
  sh: "bash", bash: "bash", zsh: "bash", md: "markdown", markdown: "markdown",
  yml: "yaml", yaml: "yaml", sql: "sql", diff: "diff", patch: "diff",
};
/** Language id from a path ("src/a.ts" → "typescript"); null when unknown.
 * @param {string} path @returns {string | null} */
export function langOf(path) {
  const name = (path.split("/").pop() || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return /** @type {Record<string, string>} */ (LANGS)[name.slice(dot + 1)] || null;
}

/** @param {{isNew?: boolean, isDeleted?: boolean, renamed?: boolean, oldPath?: string}} f @returns {"A"|"D"|"M"|"R"} */
export function fileStatus(f) {
  if (f.isNew) return "A";
  if (f.isDeleted) return "D";
  if (f.renamed || f.oldPath) return "R";
  return "M";
}

/** @returns {"unified"|"split"} */
export function readMode() {
  try { return localStorage.getItem(MODE_KEY) === "split" ? "split" : "unified"; } catch { return "unified"; }
}

/** @type {Promise<any> | null} */
let hljsPromise = null;
const langLoads = new Map();
/** Loads highlight.js and registers `lang` the first time it is needed. @param {string} lang */
async function hljsFor(lang) {
  hljsPromise ??= import("/assets/vendor/highlight/highlight.min.js").then((m) => m.default);
  const hljs = await hljsPromise;
  if (!langLoads.has(lang)) {
    langLoads.set(lang, import(/* @vite-ignore */ `/assets/vendor/highlight/languages/${lang}.min.js`).then((m) => hljs.registerLanguage(lang, m.default)));
  }
  await langLoads.get(lang);
  return hljs;
}

/** @param {string} cls @param {string} [text] @param {string} [tag] */
const el = (cls, text, tag = "div") => {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
};
const STATUS_TITLE = { A: "Added", M: "Modified", D: "Deleted", R: "Renamed" };

/**
 * @typedef {{path:string, added:number, deleted:number, isNew?:boolean, isDeleted?:boolean, binary?:boolean, conflict?:boolean}} TreeFile
 * @typedef {{
 *   files: TreeFile[],
 *   loadDiff: (path: string) => Promise<any>,
 *   onLine?: (arg: {line:number, snippet:string, after:HTMLElement, file:string}) => void,
 *   loadLines?: (path: string, from: number, to: number) => Promise<{lines: string[], total: number}>,
 *   mode?: "unified"|"split",
 *   toolbar?: boolean,
 *   collapsed?: Set<string>,
 *   decorate?: (path: string, section: HTMLElement) => void,
 *   onRender?: (path: string, body: HTMLElement, mode: "unified"|"split") => void,
 * }} ViewOptions
 */

/**
 * Mounts the file tree and the per-file diffs into `container`. loadDiff(path) resolves to `{diff, binary?, truncated?}`.
 * @param {HTMLElement} container
 * @param {ViewOptions} opts
 */
export function mountDiffView(container, opts) {
  const { loadDiff, onLine } = opts;
  const collapsed = opts.collapsed || new Set();
  const toolbarOn = opts.toolbar !== false;
  let preferred = opts.mode || readMode();
  let width = Infinity;
  /** @type {Map<string, any>} */ const states = new Map();
  /** @type {TreeFile[]} */ let files = [];
  let treeSig = "";
  let destroyed = false;

  const root = el("dv");
  const toolbar = el("dv-bar");
  const tree = el("dv-tree");
  const list = el("dv-files");
  const btn = (/** @type {string} */ text, /** @type {() => void} */ fn) => {
    const b = /** @type {HTMLButtonElement} */ (el("", text, "button"));
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  };
  const uni = btn("Unified", () => setMode("unified"));
  const spl = btn("Split", () => setMode("split"));
  const seg = el("dv-seg");
  seg.append(uni, spl);
  toolbar.append(seg, el("dv-sp"), btn("Collapse all", () => setAll(true)), btn("Expand all", () => setAll(false)));
  toolbar.hidden = !toolbarOn;
  root.append(toolbar, tree, list);
  container.replaceChildren(root);

  const mode = () => (preferred === "split" && width >= SPLIT_MIN_WIDTH ? "split" : "unified");
  const syncToolbar = () => {
    uni.classList.toggle("on", mode() === "unified");
    spl.classList.toggle("on", mode() === "split");
    spl.disabled = width < SPLIT_MIN_WIDTH;
    spl.title = spl.disabled ? "Widen the panel for split view" : "Side by side";
  };

  /** @type {IntersectionObserver | null} */
  const io = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
    for (const e of entries) {
      const st = states.get(/** @type {HTMLElement} */ (e.target).dataset.file || "");
      if (!st) continue;
      st.visible = e.isIntersecting;
      if (e.isIntersecting) ensure(st);
    }
  }, { rootMargin: "300px 0px" });

  /** @param {any} st */
  function render(st) {
    if (!st.parsed) return;
    const m = mode();
    const highlighter = st.htmls ? (/** @type {Hunk} */ _h, /** @type {number} */ i) => st.htmls[i] : undefined;
    const body = st.body;
    if (m === "split") renderSplit(body, st.parsed, { highlighter, toSplitRows });
    else { body.classList.remove("split"); renderDiff(body, st.parsed, { onLine, highlighter }); }
    st.renderedMode = m;
    addBars(st);
    if (opts.onRender) opts.onRender(st.f.path, body, m);
  }

  /** Adds the "N hidden lines" bars between hunks, above the first and below the last. @param {any} st */
  function addBars(st) {
    const parsed = st.parsed;
    if (!opts.loadLines || !parsed || parsed.binary || parsed.truncated || parsed.status === "A" || parsed.status === "D" || !parsed.hunks.length) return;
    for (const gap of gaps(parsed.hunks, st.total)) {
      const bar = expandBar(st, gap);
      if (gap.beforeHunk < parsed.hunks.length) st.body.querySelector(`.hunk[data-hunk="${gap.beforeHunk}"]`)?.before(bar);
      else {
        const note = st.body.querySelector(".note");
        if (note) note.before(bar); else st.body.append(bar);
      }
    }
  }

  /** @param {any} st @param {{beforeHunk: number, from: number, to: number}} gap */
  function expandBar(st, gap) {
    const hunks = st.parsed.hunks;
    const hidden = gap.to - gap.from + 1;
    const known = Number.isFinite(hidden);
    const hasAbove = gap.beforeHunk > 0;
    const hasBelow = gap.beforeHunk < hunks.length;
    const bar = el("expand");
    bar.dataset.file = st.f.path;
    bar.dataset.gap = String(gap.beforeHunk);
    const buttons = el("", "", "span");
    const go = (/** @type {number} */ a, /** @type {number} */ b) => () => expandLines(st, a, b);
    if (hasBelow) buttons.append(btn("↑", go(Math.max(gap.from, gap.to - EXPAND_STEP + 1), gap.to)));
    if (hasAbove) buttons.append(btn("↓", go(gap.from, Math.min(gap.to, gap.from + EXPAND_STEP - 1))));
    if (known && hidden <= EXPAND_ALL_MAX) buttons.append(btn("↕ all", go(gap.from, gap.to)));
    for (const b of buttons.children) {
      const up = b.textContent === "↑";
      /** @type {HTMLElement} */ (b).title = b.textContent === "↕ all" ? "Show all hidden lines" : up ? `Show ${EXPAND_STEP} lines above` : `Show ${EXPAND_STEP} lines below`;
    }
    bar.append(buttons, el("count", known ? `↕ ${hidden} hidden ${hidden === 1 ? "line" : "lines"}` : "↕ more lines below", "span"));
    return bar;
  }

  /** Fetches new-side lines a..b of a file and merges them into its hunks. @param {any} st @param {number} a @param {number} b */
  async function expandLines(st, a, b) {
    if (st.expanding || !opts.loadLines) return;
    st.expanding = true;
    try {
      const got = await opts.loadLines(st.f.path, a, b);
      if (destroyed || !st.parsed) return;
      st.total = got.total;
      st.parsed = { ...st.parsed, hunks: expand(st.parsed.hunks, got.from ?? a, got.lines) };
      st.htmls = null;
      st.highlighted = false;
      render(st);
      highlight(st);
    } catch {
      st.body.querySelector(`.expand[data-file="${CSS.escape(st.f.path)}"] .count`)?.append(" (could not load)");
    } finally {
      st.expanding = false;
    }
  }

  /** @param {any} st */
  function paint(st) {
    if (!st.htmls) return;
    for (const row of st.body.querySelectorAll("[data-kind]")) {
      const html = st.htmls[Number(row.dataset.hunk)]?.[row._i];
      const code = row.querySelector(".code");
      if (typeof html === "string" && code) setCode(code, "", html);
    }
  }

  /** @param {any} st */
  async function highlight(st) {
    if (st.highlighted || !st.parsed || st.parsed.binary) return;
    const lang = langOf(st.f.path);
    const total = st.parsed.hunks.reduce((n, /** @type {Hunk} */ h) => n + h.lines.length, 0);
    st.highlighted = true;
    if (!lang || total > HIGHLIGHT_MAX_LINES) return;
    try {
      const hljs = await hljsFor(lang);
      if (destroyed) return;
      const parsed = st.parsed;
      const htmls = parsed.hunks.map((/** @type {Hunk} */ h) => highlightHunk(hljs, h, lang));
      if (st.parsed !== parsed) return;
      st.htmls = htmls;
      paint(st);
    } catch { /* plain text stays */ }
  }

  /** @param {any} st @param {boolean} background */
  async function load(st, background) {
    const seq = ++st.seq;
    st.loadedKey = st.f.added + "/" + st.f.deleted;
    if (!background && !st.parsed) st.body.replaceChildren(el("note", "Loading…"));
    try {
      const data = await loadDiff(st.f.path);
      if (destroyed || seq !== st.seq || !data) return;
      const parsed = data.hunks ? data : Object.assign(parseFileDiff(st.f.path, data.diff || ""), { truncated: data.truncated, binary: data.binary || undefined });
      if (data.binary) parsed.binary = true;
      st.parsed = parsed;
      st.total = undefined;
      st.htmls = null;
      st.highlighted = false;
      const top = scroller(root);
      const before = top ? top.scrollTop : 0;
      render(st);
      if (top) top.scrollTop = before;
      if (st.visible || !io) highlight(st);
    } catch {
      if (seq !== st.seq || background) return;
      st.loadedKey = "";
      st.body.replaceChildren(el("note", "Could not load the diff"));
    }
  }

  /** @param {any} st */
  function ensure(st) {
    if (collapsed.has(st.f.path)) return;
    if (st.loadedKey !== st.f.added + "/" + st.f.deleted) load(st, !!st.parsed);
    else if (st.parsed) {
      if (st.renderedMode !== mode()) render(st);
      highlight(st);
    }
  }

  /** @param {HTMLElement} node */
  function scroller(node) {
    for (let p = node.parentElement; p; p = p.parentElement) if (p.scrollHeight > p.clientHeight && /(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
    return null;
  }

  /** @param {any} st */
  function syncHead(st) {
    const f = st.f;
    const open = !collapsed.has(f.path);
    st.sec.classList.toggle("collapsed", !open);
    st.body.hidden = !open;
    st.chev.textContent = open ? "▾" : "▸";
    st.head.setAttribute("aria-expanded", String(open));
    const status = fileStatus(f);
    st.letter.textContent = status;
    st.letter.className = "st st-" + status;
    st.letter.title = STATUS_TITLE[status];
    st.counts.replaceChildren(el("add", "+" + f.added, "span"), document.createTextNode(" "), el("del", "−" + f.deleted, "span"));
    const badges = [f.conflict ? "conflict" : null, f.binary ? "binary" : null, isLarge(f.path, f) ? "large" : null].filter(Boolean);
    st.badges.replaceChildren(...badges.map((b) => el("badge" + (b === "conflict" ? " conflict" : ""), /** @type {string} */ (b), "span")));
  }

  /** @param {any} st @param {boolean} [force] */
  function toggle(st, force) {
    const path = st.f.path;
    const close = force === undefined ? !collapsed.has(path) : force;
    if (close) collapsed.add(path); else collapsed.delete(path);
    syncHead(st);
    if (!close) ensure(st);
  }

  /** @param {boolean} close */
  function setAll(close) {
    for (const st of states.values()) toggle(st, close);
  }

  /** @param {TreeFile} f */
  function makeState(f) {
    const sec = el("dv-file");
    sec.dataset.file = f.path;
    const head = el("dv-fhead");
    head.tabIndex = 0;
    head.setAttribute("role", "button");
    const chev = el("chev", "", "span");
    const letter = el("st", "", "span");
    const slash = f.path.lastIndexOf("/");
    const name = el("path", "", "span");
    name.append(el("dir", f.path.slice(0, slash + 1), "span"), el("base", f.path.slice(slash + 1), "span"));
    const badges = el("badges", "", "span");
    const counts = el("counts", "", "span");
    head.append(chev, letter, name, badges, counts);
    const body = el("diff", undefined, "pre");
    sec.append(head, body);
    /** @type {any} */
    const st = { f: f, sec, head, body, chev, letter, counts, badges, seq: 0, loadedKey: "", parsed: null, htmls: null, highlighted: false, visible: false, renderedMode: null };
    head.addEventListener("click", () => toggle(st));
    head.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(st); } });
    if (opts.decorate) opts.decorate(f.path, sec);
    if (io) io.observe(sec);
    return st;
  }

  function renderTree() {
    const sig = JSON.stringify(files);
    if (sig === treeSig) return;
    treeSig = sig;
    const max = Math.max(1, ...files.map((f) => f.added + f.deleted));
    tree.replaceChildren(...files.map((f) => {
      const status = fileStatus(f);
      const row = el("dv-trow");
      row.dataset.file = f.path;
      row.title = f.path;
      const slash = f.path.lastIndexOf("/");
      const path = el("path", "", "span");
      path.append(el("dir", f.path.slice(0, slash + 1), "span"), el("base", f.path.slice(slash + 1), "span"));
      const total = f.added + f.deleted;
      const bar = el("bar", "", "span");
      bar.style.width = Math.max(6, Math.round((total / max) * 48)) + "px";
      if (total) {
        const a = el("a", "", "span");
        a.style.flexGrow = String(f.added);
        const d = el("d", "", "span");
        d.style.flexGrow = String(f.deleted);
        bar.append(a, d);
      }
      row.append(el("st st-" + status, status, "span"), path, el("add", "+" + f.added, "span"), el("del", "−" + f.deleted, "span"), bar);
      row.addEventListener("click", () => {
        const st = states.get(f.path);
        if (!st) return;
        if (collapsed.has(f.path)) toggle(st, false);
        st.sec.scrollIntoView({ block: "start" });
      });
      return row;
    }));
    tree.hidden = files.length === 0;
  }

  /** @param {TreeFile[]} next */
  function update(next) {
    files = next;
    const seen = new Set();
    next.forEach((f, i) => {
      seen.add(f.path);
      let st = states.get(f.path);
      if (!st) {
        if (isLarge(f.path, f)) collapsed.add(f.path);
        st = makeState(f);
        states.set(f.path, st);
      }
      st.f = f;
      syncHead(st);
      if (list.children[i] !== st.sec) list.insertBefore(st.sec, list.children[i] || null);
      if (st.visible || !io) ensure(st);
      else if (st.parsed && !collapsed.has(f.path) && st.loadedKey !== f.added + "/" + f.deleted) load(st, true);
    });
    for (const [path, st] of states) {
      if (seen.has(path)) continue;
      io?.unobserve(st.sec);
      st.sec.remove();
      states.delete(path);
    }
    renderTree();
    syncToolbar();
  }

  /** @param {"unified"|"split"} m */
  function setMode(m) {
    preferred = m;
    try { localStorage.setItem(MODE_KEY, m); } catch { /* the choice just does not persist */ }
    applyMode();
  }
  function applyMode() {
    syncToolbar();
    for (const st of states.values()) if (st.parsed && st.renderedMode !== mode()) render(st);
  }

  update(opts.files);
  return {
    el: root,
    update,
    setMode,
    mode,
    /** Enables split mode at ≥ 900px. @param {number} px */
    setWidth(px) { width = px; applyMode(); },
    destroy() { destroyed = true; io?.disconnect(); root.remove(); },
  };
}
