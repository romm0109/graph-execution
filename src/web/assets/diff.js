/** @typedef {{kind:"add"|"del"|"ctx", old?:number, new?:number, text:string}} DiffLine */
/** @typedef {{oldStart:number, oldLines:number, newStart:number, newLines:number, header:string, lines:DiffLine[]}} Hunk */
/** @typedef {{path:string, oldPath?:string, status:"A"|"M"|"D"|"R", hunks:Hunk[], binary:boolean}} ParsedFile */

export const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "Cargo.lock", "poetry.lock", "composer.lock", "Gemfile.lock", "go.sum"]);
/** @param {string} path @param {{added:number, deleted:number}} file */
export const isLarge = (path, file) => LOCKFILES.has(path.split("/").pop() || "") || file.added + file.deleted > 1000;

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * Parses one file's unified diff text (git headers skipped).
 * @param {string} path
 * @param {string} text
 * @returns {ParsedFile}
 */
export function parseFileDiff(path, text) {
  /** @type {ParsedFile} */
  const file = { path, status: "M", hunks: [], binary: false };
  const lines = (text || "").split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  /** @type {Hunk | null} */
  let hunk = null;
  let oldNo = 0, newNo = 0;
  for (const line of lines) {
    const m = HUNK.exec(line);
    if (m) {
      hunk = { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), header: m[5] || "", lines: [] };
      file.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      if (hunk.oldStart === 0 && hunk.oldLines === 0) file.status = "A";
      else if (hunk.newStart === 0 && hunk.newLines === 0) file.status = "D";
      continue;
    }
    if (!hunk) {
      if (line.startsWith("+++ /dev/null")) file.status = "D";
      else if (line.startsWith("--- /dev/null")) file.status = "A";
      else if (line.startsWith("new file mode")) file.status = "A";
      else if (line.startsWith("deleted file mode")) file.status = "D";
      else if (line.startsWith("rename from ")) { file.status = "R"; file.oldPath = line.slice(12); }
      else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) file.binary = true;
      continue;
    }
    if (line[0] === "\\") continue;
    if (line[0] === "+") hunk.lines.push({ kind: "add", new: newNo++, text: line.slice(1) });
    else if (line[0] === "-") hunk.lines.push({ kind: "del", old: oldNo++, text: line.slice(1) });
    else if (line[0] === " ") hunk.lines.push({ kind: "ctx", old: oldNo++, new: newNo++, text: line.slice(1) });
  }
  return file;
}

/**
 * Parses a multi-file `git diff` (splits on "diff --git").
 * @param {string} text
 * @returns {{files: ParsedFile[]}}
 */
export function parseUnifiedDiff(text) {
  const files = [];
  const sections = (text || "").split(/^(?=diff --git )/m).filter((s) => s.startsWith("diff --git "));
  for (const section of sections) {
    const first = section.slice(0, section.indexOf("\n") === -1 ? undefined : section.indexOf("\n")).replace(/\r$/, "");
    const hm = /^diff --git a\/(.*) b\/(.*)$/.exec(first);
    let path = hm ? hm[2] : first.slice(11);
    const rename = /^rename to (.*)$/m.exec(section);
    if (rename) path = rename[1].replace(/\r$/, "");
    else {
      const plus = /^\+\+\+ b\/(.*)$/m.exec(section);
      if (plus) path = plus[1].replace(/\r$/, "");
    }
    const file = parseFileDiff(path, section);
    if (file.status !== "R" && hm && hm[1] !== hm[2] && !rename) file.oldPath = hm[1];
    files.push(file);
  }
  return { files };
}

/** @param {string} cls @param {string} [text] */
const div = (cls, text) => {
  const d = document.createElement("div");
  if (cls) d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
};

/**
 * Renders a parsed file into `pre` (class "diff"); returns the row elements.
 * @param {HTMLElement} pre
 * @param {ParsedFile & {truncated?: boolean}} file
 * @param {{onLine?: (arg: {line:number, snippet:string, after:HTMLElement, file:string}) => void, highlighter?: Highlighter}} [opts]
 * @returns {HTMLElement[]}
 */
export function renderDiff(pre, file, { onLine, highlighter } = {}) {
  pre.classList.add("diff");
  /** @type {HTMLElement[]} */
  const rows = [];
  const kids = [];
  if (file.binary) kids.push(div("note", "Binary file"));
  else {
    file.hunks.forEach((hunk, h) => {
      const hrow = div("dl hunk");
      hrow.dataset.file = file.path;
      hrow.dataset.hunk = String(h);
      const hcode = document.createElement("span");
      hcode.className = "code";
      hcode.textContent = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` + (hunk.header ? " " + hunk.header : "");
      hrow.append(div("ln", ""), div("ln", ""), div("mk", ""), hcode);
      kids.push(hrow);
      rows.push(hrow);
      /** @type {string[]} */
      const hunkText = [];
      const html = highlighter ? highlighter(hunk, h) : null;
      hunk.lines.forEach((l, i) => {
        const row = div("dl " + l.kind);
        row.dataset.file = file.path;
        row.dataset.kind = l.kind;
        row.dataset.side = l.kind === "del" ? "old" : "new";
        row.dataset.oldLine = l.old === undefined ? "" : String(l.old);
        row.dataset.newLine = l.new === undefined ? "" : String(l.new);
        row.dataset.hunk = String(h);
        const code = document.createElement("span");
        code.className = "code";
        setCode(code, l.text, html && html[i]);
        /** @type {any} */ (row)._i = i;
        const newCell = div("ln", row.dataset.newLine);
        row.append(div("ln", row.dataset.oldLine), newCell, div("mk", l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""), code);
        if (l.kind !== "del") {
          hunkText.push(l.text);
          if (onLine) {
            const snippet = hunkText.slice(-3).join("\n");
            const line = /** @type {number} */ (l.new);
            newCell.classList.add("pick");
            newCell.title = "Comment on this line";
            newCell.addEventListener("click", () => onLine({ line, snippet, after: row, file: file.path }));
          }
        }
        kids.push(row);
        rows.push(row);
      });
    });
    if (!kids.length) kids.push(div("note", "Empty file"));
    if (file.truncated) kids.push(div("note", "Diff truncated at 200 KB"));
  }
  const frag = document.createDocumentFragment();
  frag.append(...kids);
  pre.replaceChildren(frag);
  return rows;
}

/** @typedef {(hunk: Hunk, index: number) => (string | undefined)[] | null | undefined} Highlighter one HTML string per hunk line (from highlight.js), or nothing for plain text */

/**
 * Plain text via textContent, or highlighter HTML (the only innerHTML in the diff view; highlight.js escapes its input).
 * @param {HTMLElement} code @param {string} text @param {string | null | undefined} html
 */
export function setCode(code, text, html) {
  if (typeof html === "string") code.innerHTML = html;
  else code.textContent = text;
}

/**
 * Renders a parsed file side by side into `pre` (class "diff split"): one grid row per pair, each half its own element with data-side.
 * @param {HTMLElement} pre
 * @param {ParsedFile & {truncated?: boolean}} file
 * @param {{highlighter?: Highlighter, toSplitRows: (hunk: Hunk) => Array<{left?: DiffLine, right?: DiffLine}>}} opts
 * @returns {HTMLElement[]} the half-row elements
 */
export function renderSplit(pre, file, { highlighter, toSplitRows }) {
  pre.classList.add("diff", "split");
  /** @type {HTMLElement[]} */
  const rows = [];
  const kids = [];
  if (file.binary) kids.push(div("note", "Binary file"));
  else {
    file.hunks.forEach((hunk, h) => {
      const hrow = div("dl hunk");
      hrow.dataset.file = file.path;
      hrow.dataset.hunk = String(h);
      hrow.textContent = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` + (hunk.header ? " " + hunk.header : "");
      kids.push(hrow);
      const html = highlighter ? highlighter(hunk, h) : null;
      const index = new Map(hunk.lines.map((l, i) => [l, i]));
      /** @param {DiffLine | undefined} l @param {"old"|"new"} side */
      const half = (l, side) => {
        if (!l) return [div("ln blank", ""), div("code blank", "")];
        const el = div("dl half " + l.kind);
        el.dataset.file = file.path;
        el.dataset.kind = l.kind;
        el.dataset.oldLine = l.old === undefined ? "" : String(l.old);
        el.dataset.newLine = l.new === undefined ? "" : String(l.new);
        el.dataset.hunk = String(h);
        el.dataset.side = side;
        const code = document.createElement("span");
        code.className = "code";
        setCode(code, l.text, html && html[index.get(l)]);
        /** @type {any} */ (el)._i = index.get(l);
        el.append(div("ln", side === "old" ? el.dataset.oldLine : el.dataset.newLine), code);
        rows.push(el);
        return [el];
      };
      for (const pair of toSplitRows(hunk)) {
        const srow = div("srow");
        srow.append(...half(pair.left, "old"), ...half(pair.right, "new"));
        kids.push(srow);
      }
    });
    if (!kids.length) kids.push(div("note", "Empty file"));
    if (file.truncated) kids.push(div("note", "Diff truncated at 200 KB"));
  }
  const frag = document.createDocumentFragment();
  frag.append(...kids);
  pre.replaceChildren(frag);
  return rows;
}
