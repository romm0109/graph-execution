// @ts-check
// The Logs tab shared by the run and suite pages: one collapsible block per log file, live text, filter, auto-scroll.

const enc = new TextEncoder();
const dec = new TextDecoder();
const RELIST_MS = 2000;

/**
 * Pure: log labels (file names without .log) that belong to a run-page node. Kept identical to `labelsForNode` in logtail.ts.
 * @param {string} nodeId
 * @param {string[]} labels
 */
export function labelsForNode(nodeId, labels) {
  /** @type {Record<string, RegExp>} */
  const own = { "@reviewer": /^code-r\d+$/, "@tester": /^tester-r\d+$/, "@fixer": /^fix-r\d+(-v\d+)?$/, "@gate-fixer": /^fix-r\d+-v\d+$/ };
  const task = nodeId.startsWith("@") ? undefined : new RegExp("^" + nodeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(-validate-\\d+)?$");
  const re = own[nodeId] || task;
  const summary = "summary-" + nodeId.replace(/[^\w.-]+/g, "-");
  return labels.filter((l) => (re ? re.test(l) : false) || l === summary);
}

/**
 * Pure: appends a chunk at a byte offset; data already seen (after a reconnect) is ignored.
 * @param {{offset: number, text: string}} state
 * @param {{offset: number, text: string}} chunk
 */
export function mergeTail(state, { offset, text }) {
  const bytes = enc.encode(text);
  const end = offset + bytes.length;
  if (end <= state.offset) return state;
  const fresh = offset < state.offset ? dec.decode(bytes.subarray(state.offset - offset)) : text;
  return { offset: end, text: state.text + fresh };
}

/**
 * Pure: the lines containing `query` (case-insensitive), with the first match's [start, end]; all lines when the query is empty.
 * @param {string} text
 * @param {string} query
 * @returns {{line: string, match: [number, number] | null}[]}
 */
export function filterLines(text, query) {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const q = query.toLowerCase();
  if (q === "") return lines.map((line) => ({ line, match: null }));
  const out = [];
  for (const line of lines) {
    const i = line.toLowerCase().indexOf(q);
    if (i >= 0) out.push({ line, match: /** @type {[number, number]} */ ([i, i + q.length]) });
  }
  return out;
}

/**
 * @param {string} tag
 * @param {string} [cls]
 * @param {string} [text]
 */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** @param {string} [cls] @param {string} [text] */
function btn(cls, text) { return /** @type {HTMLButtonElement} */ (el("button", cls, text)); }

const countLines = (/** @type {string} */ t) => t.split("\n").length - 1;

/**
 * @param {HTMLElement} tabEl the scrollable tab container
 * @param {{list(): Promise<{label: string, size: number, tail: string, mtime?: number}[]>, subscribe(labels: string[], onChunk: (c: {label: string, offset: number, text: string}) => void, offsets?: Record<string, number>): () => void, full(label: string): Promise<{text: string, truncated: boolean, size?: number}>}} src
 * @returns {{destroy(): void}}
 */
export function mountLogs(tabEl, src) {
  let query = "";
  let unseen = 0;
  let stuck = true;
  let destroyed = false;
  /** @type {() => void} */
  let unsubscribe = () => {};
  /** @type {Map<string, {label: string, state: {offset: number, text: string}, open: boolean, notice: HTMLElement, pre: HTMLElement, head: HTMLElement, text: Text | null, truncated: boolean}>} */
  const blocks = new Map();

  const bar = el("div", "logs-bar");
  const filter = /** @type {HTMLInputElement} */ (el("input", "logs-filter"));
  filter.type = "search";
  filter.placeholder = "Filter lines";
  filter.setAttribute("aria-label", "Filter log lines");
  bar.append(filter);
  const list = el("div", "logs-list");
  const empty = el("div", "placeholder", "Loading logs…");
  const chip = btn("logs-chip");
  chip.type = "button";
  chip.hidden = true;
  tabEl.replaceChildren(bar, empty, list, chip);

  const atBottom = () => tabEl.scrollHeight - tabEl.scrollTop - tabEl.clientHeight < 24;
  const toBottom = () => { tabEl.scrollTop = tabEl.scrollHeight; };
  const showChip = () => {
    chip.hidden = unseen === 0;
    chip.textContent = "↓ " + unseen + " new line" + (unseen === 1 ? "" : "s");
  };
  const onScroll = () => {
    stuck = atBottom();
    if (stuck && unseen) { unseen = 0; showChip(); }
  };
  tabEl.addEventListener("scroll", onScroll);
  chip.addEventListener("click", () => { stuck = true; unseen = 0; showChip(); toBottom(); });

  /** @param {{pre: HTMLElement, state: {text: string}, text: Text | null}} b */
  function paint(b) {
    if (query === "") {
      b.text = document.createTextNode(b.state.text || "(empty)");
      b.pre.replaceChildren(b.text);
      return;
    }
    b.text = null;
    const rows = filterLines(b.state.text, query).map(({ line, match }) => {
      const row = el("div", "logs-line");
      if (match) row.append(line.slice(0, match[0]), el("mark", "", line.slice(match[0], match[1])), line.slice(match[1]));
      return row;
    });
    b.pre.replaceChildren(...(rows.length ? rows : [el("div", "logs-none", "No matching lines")]));
  }

  /** @param {{label: string, size: number, tail: string}} l @param {boolean} open */
  function addBlock(l, open) {
    const head = btn("logs-head");
    head.type = "button";
    const pre = el("pre", "logs-text");
    const notice = el("div", "logs-notice");
    notice.hidden = true;
    const full = btn("logs-full", "Load full log");
    full.type = "button";
    const b = { label: l.label, state: { offset: l.size, text: l.tail }, open, notice, pre, head, text: /** @type {Text | null} */ (null), truncated: false };
    const title = () => { head.textContent = (b.open ? "▾ " : "▸ ") + b.label; };
    const sync = () => { title(); pre.hidden = !b.open; full.hidden = !b.open; notice.hidden = !b.open || !b.truncated; };
    head.addEventListener("click", () => { b.open = !b.open; sync(); });
    full.addEventListener("click", async () => {
      full.disabled = true;
      try {
        const r = await src.full(b.label);
        b.state = { offset: r.size === undefined ? b.state.offset : r.size, text: r.text };
        b.truncated = r.truncated;
        notice.textContent = r.truncated ? "Truncated: showing the last 5 MB of this log." : "";
        full.hidden = true;
        paint(b);
        sync();
      } catch {
        notice.textContent = "Could not load the full log.";
        notice.hidden = false;
        full.disabled = false;
      }
    });
    const wrap = el("section", "logs-block");
    wrap.append(head, full, notice, pre);
    list.append(wrap);
    blocks.set(l.label, b);
    paint(b);
    sync();
    return b;
  }

  /** @param {{label: string, offset: number, text: string}} c */
  function onChunk(c) {
    const b = blocks.get(c.label);
    if (!b || destroyed) return;
    const before = b.state;
    b.state = mergeTail(before, c);
    if (b.state === before) return;
    const added = b.state.text.slice(before.text.length);
    if (query === "" && b.text) {
      if (b.state.text === added && before.text === "") paint(b);
      else b.text.appendData(added);
    } else paint(b);
    if (!b.open) return;
    if (stuck) toBottom();
    else { unseen += Math.max(1, countLines(added)); showChip(); }
  }

  filter.addEventListener("input", () => {
    query = filter.value;
    for (const b of blocks.values()) paint(b);
    if (stuck) toBottom();
  });

  /** @type {Record<string, number>} */
  const sizes = {};
  /** @param {boolean} first */
  async function refresh(first) {
    let logs;
    try { logs = await src.list(); } catch { if (first) empty.textContent = "Could not load logs"; return; }
    if (destroyed) return;
    const fresh = logs.filter((l) => !blocks.has(l.label));
    if (!fresh.length && !first) return;
    // The newest file (by modification time, else the last one listed) starts expanded.
    const newest = [...logs].sort((a, b) => (b.mtime || 0) - (a.mtime || 0))[0];
    for (const l of fresh) sizes[l.label] = l.size;
    // A file that shows up later also opens when no block is open yet, so new output is never hidden.
    const noneOpen = ![...blocks.values()].some((b) => b.open);
    for (const l of [...fresh].sort((a, b) => (b.mtime || 0) - (a.mtime || 0))) addBlock(l, (first || noneOpen) && l === newest);
    empty.hidden = blocks.size > 0;
    empty.textContent = "No agent logs for this node yet";
    unsubscribe();
    if (blocks.size) unsubscribe = src.subscribe([...blocks.keys()], onChunk, sizes);
    if (first) toBottom();
  }

  refresh(true);
  const timer = setInterval(() => refresh(false), RELIST_MS);
  return {
    destroy() {
      destroyed = true;
      clearInterval(timer);
      unsubscribe();
      tabEl.removeEventListener("scroll", onScroll);
    },
  };
}
