// @ts-check
// GitHub-style line selection and the inline comment composer, shared by the run page and the suite page.
import { renderMarkdown } from "./markdown.js";

/**
 * @typedef {{ kind: "add" | "del" | "ctx", old: number | null, new: number | null, hunk: number, file: string, text?: string, el?: HTMLElement }} Row
 * @typedef {{ side: "new" | "old", startLine: number, endLine: number }} Anchor
 */

const SNIPPET_MAX = 2000;
const CUT = "\n… (cut)";

/**
 * Inclusive `[from, to]` index range between two rows, clipped to the anchor row's file and hunk.
 * @param {Row[]} rows
 * @param {number} anchorIdx
 * @param {number} focusIdx
 * @returns {[number, number]}
 */
export function rangeFrom(rows, anchorIdx, focusIdx) {
  const a = rows[anchorIdx];
  if (!a) return [anchorIdx, anchorIdx];
  const same = (/** @type {Row | undefined} */ r) => !!r && r.file === a.file && r.hunk === a.hunk;
  let lo = anchorIdx;
  while (lo > 0 && same(rows[lo - 1])) lo--;
  let hi = anchorIdx;
  while (hi < rows.length - 1 && same(rows[hi + 1])) hi++;
  const from = Math.min(anchorIdx, focusIdx);
  const to = Math.max(anchorIdx, focusIdx);
  return [Math.max(from, lo), Math.min(to, hi)];
}

/**
 * The side and line numbers a selection is anchored to. All-deleted selections anchor to the old side.
 * @param {Row[]} rows
 * @param {{ side?: "new" | "old" }} [opts] forces the side (split view)
 * @returns {Anchor}
 */
export function anchor(rows, opts = {}) {
  const side = opts.side ?? (rows.length > 0 && rows.every((r) => r.kind === "del") ? "old" : "new");
  const nums = rows.map((r) => (side === "old" ? r.old : r.new)).filter((n) => n !== null && n !== undefined);
  return { side, startLine: /** @type {number} */ (nums[0]), endLine: /** @type {number} */ (nums[nums.length - 1]) };
}

/**
 * The selected text; `+`/`-` prefixes mark added and deleted rows when the range mixes kinds.
 * @param {Row[]} rows
 */
export function snippetFor(rows) {
  const mixed = new Set(rows.map((r) => r.kind)).size > 1;
  const text = rows.map((r) => (mixed ? (r.kind === "add" ? "+" : r.kind === "del" ? "-" : "") : "") + (r.text ?? "")).join("\n");
  return text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX - CUT.length) + CUT : text;
}

/** @param {Anchor} a */
export function rangeText({ side, startLine, endLine }) {
  const n = (/** @type {number} */ v) => (side === "old" ? "−" : "+") + v;
  return startLine === endLine ? `line ${n(startLine)}` : `lines ${n(startLine)} to ${n(endLine)}`;
}

/**
 * Wraps the selection in `before`/`after` (or inserts them at the cursor) and returns the new value and cursor.
 * With a selection the cursor lands after the wrapped text; without one it lands between `before` and `after`.
 * @param {string} value
 * @param {number} selStart
 * @param {number} selEnd
 * @param {string} before
 * @param {string} after
 * @returns {{ value: string, cursor: number }}
 */
export function insertAt(value, selStart, selEnd, before, after) {
  const sel = value.slice(selStart, selEnd);
  const next = value.slice(0, selStart) + before + sel + after + value.slice(selEnd);
  return { value: next, cursor: selStart + before.length + sel.length + (sel ? after.length : 0) };
}

/** True when `pos` is inside an open ``` fence of `value`. @param {string} value @param {number} pos */
export function inFence(value, pos) {
  const n = (value.slice(0, pos).match(/^```/gm) ?? []).length;
  return n % 2 === 1;
}

/**
 * Comments of one file grouped by the row key they hang under: "new:18" / "old:42" / "file".
 * @param {{ file?: string, side?: "new" | "old", endLine?: number }[]} comments
 * @param {string} file
 * @returns {Record<string, any[]>}
 */
export function threadsByRow(comments, file) {
  /** @type {Record<string, any[]>} */
  const out = {};
  for (const c of comments) {
    if (c.file !== file) continue;
    const key = c.endLine === undefined ? "file" : (c.side === "old" ? "old:" : "new:") + c.endLine;
    (out[key] ??= []).push(c);
  }
  return out;
}

// ---- DOM ----

const ROW = ".dl[data-kind]";
/** @type {{ clear(): void } | null} */
let activeSelection = null;

/** @param {HTMLElement} el @returns {Row} */
function rowOf(el) {
  const num = (/** @type {string | undefined} */ v) => (v ? Number(v) : null);
  const d = el.dataset;
  return {
    kind: /** @type {Row["kind"]} */ (d.kind),
    old: num(d.oldLine),
    new: num(d.newLine),
    hunk: Number(d.hunk ?? 0),
    file: d.file ?? "",
    text: el.querySelector(".code")?.textContent ?? "",
    el,
  };
}

/** @param {Element | null} el @returns {HTMLElement | null} */
function scroller(el) {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/**
 * Adds a `+` gutter button to every diff row of `container` and reports selections.
 * @param {HTMLElement} container
 * @param {{ onSelect: (s: { file: string, rows: Row[], anchor: Anchor, snippet: string, lastRow: HTMLElement }) => void }} opts
 */
export function mountSelection(container, opts) {
  const existing = /** @type {any} */ (container).__selection;
  if (existing) {
    existing.opts = opts;
    existing.refresh();
    return existing.handle;
  }
  const ctl = { opts, refresh: () => {}, handle: { clear: () => {} } };
  /** @type {any} */ (container).__selection = ctl;
  /** @type {HTMLElement[]} */
  let els = [];
  /** @type {Row[]} */
  let rows = [];
  /** @type {{ a: number, f: number } | null} */
  let sel = null;
  let dragging = false;
  /** @type {{ x: number, y: number } | null} */
  let last = null;
  let frame = 0;

  // Row indices of the current selection; in split view only the side the selection started on.
  const picks = () => {
    if (!sel) return [];
    const [from, to] = rangeFrom(rows, sel.a, sel.f);
    const half = els[sel.a]?.classList.contains("half");
    const side = half ? els[sel.a]?.dataset.side : undefined;
    const out = [];
    for (let i = from; i <= to; i++) if (!side || els[i]?.dataset.side === side) out.push(i);
    return out;
  };
  const paint = () => {
    const idx = new Set(picks());
    els.forEach((el, i) => el.classList.toggle("sel", idx.has(i)));
  };
  const clear = () => {
    sel = null;
    paint();
  };
  const refresh = () => {
    els = [...container.querySelectorAll(ROW)].map((e) => /** @type {HTMLElement} */ (e));
    rows = els.map(rowOf);
    els.forEach((el, i) => {
      if (el.querySelector(".addc")) return;
      const cell = el.children[el.classList.contains("half") || el.dataset.kind === "del" ? 0 : 1];
      if (!cell) return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "addc";
      b.textContent = "+";
      b.dataset.idx = String(i);
      b.title = "Comment on this line (drag or shift-click to select a range)";
      b.setAttribute("aria-label", "Comment on line");
      cell.append(b);
    });
    paint();
  };
  const emit = () => {
    const idx = picks();
    const last = idx[idx.length - 1];
    const lastRow = last === undefined ? undefined : els[last];
    if (!lastRow || !sel) return;
    const picked = idx.map((i) => /** @type {Row} */ (rows[i]));
    const side = els[sel.a]?.classList.contains("half") ? /** @type {"new" | "old"} */ (els[sel.a]?.dataset.side) : undefined;
    ctl.opts.onSelect({ file: picked[0]?.file ?? "", rows: picked, anchor: anchor(picked, side ? { side } : {}), snippet: snippetFor(picked), lastRow });
  };
  const start = () => {
    if (activeSelection && activeSelection !== ctl.handle) activeSelection.clear();
    activeSelection = ctl.handle;
  };
  const rowAt = (/** @type {number} */ x, /** @type {number} */ y) => {
    const hit = document.elementFromPoint(x, y)?.closest(ROW);
    const i = hit ? els.indexOf(/** @type {HTMLElement} */ (hit)) : -1;
    return i;
  };
  const tick = () => {
    frame = 0;
    if (!dragging || !last || !sel) return;
    const i = rowAt(last.x, last.y);
    if (i >= 0 && i !== sel.f) {
      sel.f = i;
      paint();
    }
    const sc = scroller(container);
    if (sc) {
      const r = sc.getBoundingClientRect();
      const dy = last.y < r.top + 40 ? -14 : last.y > r.bottom - 40 ? 14 : 0;
      if (dy) {
        sc.scrollTop += dy;
        frame = requestAnimationFrame(tick);
      }
    }
  };
  const move = (/** @type {PointerEvent} */ ev) => {
    last = { x: ev.clientX, y: ev.clientY };
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const up = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", up);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (!dragging) return;
    dragging = false;
    if (last) {
      const i = rowAt(last.x, last.y);
      if (i >= 0 && sel) sel.f = i;
    }
    paint();
    emit();
  };

  container.addEventListener("pointerdown", (ev) => {
    const b = /** @type {HTMLElement} */ (ev.target).closest?.(".addc");
    if (!b || !container.contains(b) || ev.button !== 0) return;
    ev.preventDefault();
    const idx = Number(/** @type {HTMLElement} */ (b).dataset.idx);
    start();
    sel = ev.shiftKey && sel ? { a: sel.a, f: idx } : { a: idx, f: idx };
    dragging = true;
    last = { x: ev.clientX, y: ev.clientY };
    paint();
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
  });
  container.addEventListener("keydown", (ev) => {
    const b = /** @type {HTMLElement} */ (ev.target).closest?.(".addc");
    if (!b) return;
    const idx = Number(/** @type {HTMLElement} */ (b).dataset.idx);
    if (ev.shiftKey && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
      ev.preventDefault();
      start();
      if (!sel) sel = { a: idx, f: idx };
      const next = Math.max(0, Math.min(rows.length - 1, sel.f + (ev.key === "ArrowDown" ? 1 : -1)));
      sel.f = rangeFrom(rows, sel.a, next).includes(next) ? next : sel.f;
      paint();
      /** @type {HTMLElement | null | undefined} */ (els[sel.f]?.querySelector(".addc"))?.focus();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      start();
      if (!sel) sel = { a: idx, f: idx };
      emit();
    }
  });
  ctl.refresh = refresh;
  ctl.handle = { clear };
  refresh();
  return ctl.handle;
}

/** @type {{ box: HTMLElement, ta: HTMLTextAreaElement, saving: boolean, close: () => void } | null} */
let composer = null;

/** True while a composer holds unsaved text, so the page must not rebuild the diff under it. */
export function composerDirty() {
  return !!composer && !composer.saving && composer.ta.value.trim() !== "";
}

/** @param {string} key */
function readDraft(key) {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** @param {string} key @param {string | null} value null removes the draft */
function writeDraft(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Opens the comment box under `afterRow`. Returns null when the user keeps the composer that is already open.
 * @param {HTMLElement} afterRow
 * @param {{ title: string, draftKey?: string, initial?: string, snippet?: string, suggestionText?: string, allowEmpty?: boolean, onSave: (body: string, liveCheck: boolean, err: HTMLElement) => Promise<boolean>, onCancel?: () => void }} opts
 */
export function openComposer(afterRow, { title, draftKey, initial, snippet, suggestionText, allowEmpty, onSave, onCancel }) {
  if (composer) {
    if (composerDirty() && !confirm("Discard the comment you are writing?")) return null;
    composer.close();
  }
  const box = document.createElement("div");
  box.className = "composer";
  const head = document.createElement("div");
  head.className = "composer-head";
  head.textContent = /^commenting on /i.test(title) ? title : "Commenting on " + title;
  const ta = document.createElement("textarea");
  ta.rows = 8;
  ta.className = "composer-text";
  ta.placeholder = "Leave a comment";
  if (initial !== undefined) ta.value = initial;
  else if (draftKey) ta.value = readDraft(draftKey);
  const tabs = document.createElement("div");
  tabs.className = "tabs";
  const tab = (/** @type {string} */ name) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = name;
    return b;
  };
  const writeTab = tab("Write");
  const previewTab = tab("Preview");
  const tools = document.createElement("div");
  tools.className = "tools";
  const tool = (/** @type {string} */ label, /** @type {string} */ titleText, /** @type {() => void} */ fn) => {
    const b = tab(label);
    b.title = titleText;
    b.addEventListener("click", fn);
    tools.append(b);
    return b;
  };
  const md = document.createElement("div");
  md.className = "md";
  md.hidden = true;
  const apply = (/** @type {string} */ before, /** @type {string} */ after) => {
    const r = insertAt(ta.value, ta.selectionStart, ta.selectionEnd, before, after);
    ta.value = r.value;
    ta.setSelectionRange(r.cursor, r.cursor);
    ta.focus();
    ta.dispatchEvent(new Event("input"));
  };
  const sugg = tool("Suggestion", "Suggest a change to the selected lines", () => {
    ta.setSelectionRange(ta.selectionStart, ta.selectionStart);
    apply("\n```suggestion\n" + (suggestionText ?? ""), "\n```\n");
  });
  if (suggestionText === undefined) {
    sugg.disabled = true;
    sugg.title = "Suggestions need lines on the new side";
  }
  tool("B", "Bold", () => apply("**", "**")).style.fontWeight = "bold";
  tool("</>", "Code", () => apply("`", "`"));
  tool("🔗", "Link", () => apply("[", "](https://)"));
  tabs.append(writeTab, previewTab, tools);
  const show = (/** @type {boolean} */ preview) => {
    writeTab.classList.toggle("on", !preview);
    previewTab.classList.toggle("on", preview);
    ta.hidden = preview;
    tools.hidden = preview;
    md.hidden = !preview;
    if (preview) md.innerHTML = renderMarkdown(ta.value, { snippet });
    else ta.focus();
  };
  writeTab.addEventListener("click", () => show(false));
  previewTab.addEventListener("click", () => show(true));
  const foot = document.createElement("div");
  foot.className = "composer-foot";
  const label = document.createElement("label");
  const check = document.createElement("input");
  check.type = "checkbox";
  label.append(check, " needs live check");
  const err = document.createElement("span");
  err.className = "err";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "primary";
  save.textContent = "Comment";
  foot.append(label, err, cancel, save);
  box.append(head, tabs, ta, md, foot);
  show(false);

  const state = { box, ta, saving: false, close: () => {} };
  const grow = () => {
    const panel = box.closest("#panel");
    const max = 0.6 * (panel ? panel.clientHeight : window.innerHeight);
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, max) + "px";
    ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  };
  state.close = () => {
    box.remove();
    if (composer === state) composer = null;
  };
  const doCancel = () => {
    if (ta.value.trim() && !confirm("Discard this comment?")) return;
    if (draftKey) writeDraft(draftKey, null);
    state.close();
    onCancel?.();
  };
  const doSave = async () => {
    if (state.saving) return;
    if (!allowEmpty && !ta.value.trim()) {
      err.textContent = "Write a comment first";
      return;
    }
    err.textContent = "";
    state.saving = true;
    save.disabled = true;
    const ok = await onSave(ta.value, check.checked, err).finally(() => {
      state.saving = false;
      save.disabled = false;
    });
    if (ok) {
      if (draftKey) writeDraft(draftKey, null);
      state.close();
    }
  };
  ta.addEventListener("input", () => {
    grow();
    if (draftKey) writeDraft(draftKey, ta.value);
  });
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Tab" && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && inFence(ta.value, ta.selectionStart)) {
      ev.preventDefault();
      apply("  ", "");
    }
  });
  box.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      doSave();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      doCancel();
    }
  });
  cancel.addEventListener("click", doCancel);
  save.addEventListener("click", doSave);
  composer = state;
  afterRow.after(box);
  grow();
  box.scrollIntoView({ block: "nearest" });
  ta.focus();
  return box;
}

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** @param {string} label @param {() => void} fn */
function actionButton(label, fn) {
  const b = /** @type {HTMLButtonElement} */ (el("button", "", label));
  b.type = "button";
  b.addEventListener("click", fn);
  return b;
}

/** A line of the thread with an evidence block that opens on click. */
function outcomeLine(/** @type {string} */ label, /** @type {string} */ text, /** @type {string} */ cls, /** @type {string | undefined} */ evidence) {
  const d = el("details", "outcome");
  const sum = el("summary");
  sum.append(el("b", "", label + " "), el("span", "chip " + cls, text));
  d.append(sum, el("pre", "evidence", evidence || "No evidence"));
  return d;
}

/**
 * A comment as an inline thread card. `editable` marks the current round (Edit/Delete); earlier rounds get Resolve/Reopen.
 * @param {any} c
 * @param {{ editable: boolean, outcome?: any, onEdit: (body: string, liveCheck: boolean, err: HTMLElement) => Promise<boolean>, onDelete: (err: HTMLElement) => Promise<boolean> | void, onResolve: (err: HTMLElement) => Promise<boolean> | void, onReopen: (followUp: string, err: HTMLElement) => Promise<boolean> }} opts
 */
export function renderThread(c, { editable, outcome, onEdit, onDelete, onResolve, onReopen }) {
  const box = el("div", "thread");
  box.dataset.id = c.id;
  const meta = el("div", "meta");
  meta.append(c.id);
  if (c.endLine !== undefined) meta.append(" · " + rangeText({ side: c.side, startLine: c.startLine ?? c.endLine, endLine: c.endLine }));
  else meta.append(c.file ? " · file comment" : " · general");
  if (c.liveCheck) meta.append(" · needs live check");
  const status = c.status ?? "open";
  meta.append(" · ", el("span", "chip st-" + status, status));
  box.append(meta);
  const body = el("div", "md");
  body.innerHTML = renderMarkdown(c.body, { snippet: c.snippet });
  box.append(body);
  for (const f of c.followUps ?? []) {
    const m = el("div", "md followup");
    m.innerHTML = renderMarkdown(f, { snippet: c.snippet });
    box.append(el("div", "meta", "Follow-up:"), m);
  }
  if (!editable) {
    const o = outcome ?? {};
    box.append(el("div", "fixer", "Fixer: " + (o.fixerNote || "no note")));
    if (o.verdict) box.append(outcomeLine("Reviewer:", o.verdict === "addressed" ? "addressed" : "not addressed", o.verdict === "addressed" ? "ok" : "bad", o.evidence));
    else box.append(el("div", "meta", "Reviewer: no verdict"));
    if (o.liveCheck) box.append(outcomeLine("Live check:", o.liveCheck.verdict, o.liveCheck.verdict === "pass" ? "ok" : "bad", o.liveCheck.evidence));
  }
  const err = el("span", "err");
  const actions = el("div", "actions");
  if (editable) {
    actions.append(
      actionButton("Edit", () => {
        openComposer(box, {
          title: c.endLine !== undefined ? rangeText({ side: c.side, startLine: c.startLine ?? c.endLine, endLine: c.endLine }) : c.file ? "file " + c.file : "general",
          initial: c.body,
          snippet: c.snippet,
          suggestionText: c.snippet !== undefined && c.side === "new" && c.endLine !== undefined ? newSideText(c.snippet) : undefined,
          onSave: onEdit,
        });
      }),
      actionButton("Delete", () => {
        if (confirm("Delete comment " + c.id + "?")) onDelete(err);
      }),
    );
  } else {
    if (c.status !== "resolved") actions.append(actionButton("Resolve", () => onResolve(err)));
    actions.append(
      actionButton("Reopen", () => {
        openComposer(box, { title: "Follow-up for " + c.id, snippet: c.snippet, allowEmpty: true, onSave: (text, _live, e) => onReopen(text, e) });
      }),
    );
  }
  actions.append(err);
  box.append(actions);
  box.addEventListener("mouseenter", () => highlight(box, c, true));
  box.addEventListener("mouseleave", () => highlight(box, c, false));
  return box;
}

/** New-side code of a stored snippet: `-` rows are old-side, a leading `+` marks an added row. @param {string} snippet */
function newSideText(snippet) {
  return snippet.split("\n").filter((l) => !l.startsWith("-")).map((l) => (l.startsWith("+") ? l.slice(1) : l)).join("\n");
}

/** Marks the rows a thread comments on. @param {HTMLElement} box @param {any} c @param {boolean} on */
function highlight(box, c, on) {
  const host = box.parentElement;
  if (!host || c.endLine === undefined) return;
  const attr = c.side === "old" ? "oldLine" : "newLine";
  const from = c.startLine ?? c.endLine;
  for (const r of host.querySelectorAll(ROW)) {
    const n = Number(/** @type {HTMLElement} */ (r).dataset[attr] || NaN);
    if (n >= from && n <= c.endLine) r.classList.toggle("hl", on);
    else r.classList.remove("hl");
  }
}

// ---- Comments list ----

/**
 * Comments grouped by round (newest first), then by file; general comments sit under file null.
 * @param {any[]} comments
 * @param {{ filter?: "open" | "resolved" | "all", round?: number }} [opts] `round` limits the list to one round
 * @returns {{round:number, files:{file:string|null, comments:any[]}[]}[]}
 */
export function groupComments(comments, { filter = "open", round } = {}) {
  const keep = comments.filter((c) => {
    if (round !== undefined && c.round !== round) return false;
    const resolved = c.status === "resolved";
    return filter === "all" || (filter === "resolved" ? resolved : !resolved);
  });
  /** @type {Map<number, Map<string | null, any[]>>} */
  const rounds = new Map();
  for (const c of keep) {
    const files = rounds.get(c.round) ?? new Map();
    rounds.set(c.round, files);
    const key = c.file || null;
    files.set(key, [...(files.get(key) ?? []), c]);
  }
  return [...rounds.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([r, files]) => ({
      round: r,
      files: [...files.entries()].map(([file, list]) => ({ file, comments: list })).sort((a, b) => (a.file === null ? 1 : 0) - (b.file === null ? 1 : 0) || (a.file ?? "").localeCompare(b.file ?? "")),
    }));
}

/** Open comments per file in one round. @param {any[]} comments @param {number} round @returns {Map<string, number>} */
export function openCountByFile(comments, round) {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const c of comments) {
    if (c.round !== round || !c.file || c.status === "resolved") continue;
    out.set(c.file, (out.get(c.file) ?? 0) + 1);
  }
  return out;
}

/**
 * The Comments tab body: filter pills, then rounds, files and one row per comment.
 * @param {HTMLElement} container
 * @param {any[]} comments all comments of the run
 * @param {Record<string, any>} outcomes keyed by comment id
 * @param {{ filter: "open" | "resolved" | "all", thisRound?: boolean, round?: number, onFilter: (filter: "open" | "resolved" | "all", thisRound: boolean) => void, onJump: (c: any) => void }} opts `round` is the round shown, used by "this round only"
 */
export function renderCommentList(container, comments, outcomes, { filter, thisRound = false, round, onFilter, onJump }) {
  const bar = el("div", "cfilters");
  /** @type {["open" | "resolved" | "all", string][]} */
  const pills = [["open", "Open"], ["resolved", "Resolved"], ["all", "All"]];
  for (const [value, label] of pills) {
    const b = actionButton(label, () => onFilter(value, thisRound));
    b.className = "pill" + (value === filter ? " on" : "");
    bar.append(b);
  }
  const lab = el("label", "pill-toggle");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = thisRound;
  box.addEventListener("change", () => onFilter(filter, box.checked));
  lab.append(box, " this round only");
  bar.append(lab);
  const kids = [bar];
  const groups = groupComments(comments, { filter, round: thisRound ? round : undefined });
  if (!groups.length) kids.push(el("div", "meta", "No comments"));
  for (const g of groups) {
    const all = comments.filter((c) => c.round === g.round);
    const shown = g.files.reduce((n, f) => n + f.comments.length, 0);
    const verdicts = g.files.flatMap((f) => f.comments).map((c) => outcomes[c.id]?.verdict).filter(Boolean);
    const addressed = verdicts.filter((v) => v === "addressed").length;
    const counts = verdicts.length ? ` (${addressed} addressed, ${verdicts.length - addressed} not addressed)` : "";
    kids.push(el("h4", "chead", `Round ${g.round} · ${shown} comment${shown === 1 ? "" : "s"}${counts}${shown !== all.length ? ` of ${all.length}` : ""}`));
    for (const f of g.files) {
      kids.push(el("div", "cfile", f.file ?? "General"));
      const list = el("ul", "clist");
      for (const c of f.comments) {
        const li = el("li", "crow");
        li.tabIndex = 0;
        li.dataset.id = c.id;
        const status = c.status ?? "open";
        const dot = el("span", "cdot st-" + status);
        dot.title = status;
        const where = c.file ? (c.endLine !== undefined ? `${c.file}:L${c.startLine ?? c.endLine}${(c.startLine ?? c.endLine) !== c.endLine ? "–L" + c.endLine : ""}` : c.file) : "general";
        const first = String(c.body ?? "").split("\n")[0] ?? "";
        li.append(dot, el("span", "cwhere", where), el("span", "cexcerpt", first.length > 80 ? first.slice(0, 80) + "…" : first));
        const v = outcomes[c.id]?.verdict;
        if (v) li.append(el("span", "chip " + (v === "addressed" ? "ok" : "bad"), v === "addressed" ? "addressed" : "not addressed"));
        li.addEventListener("click", () => onJump(c));
        li.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") onJump(c);
        });
        list.append(li);
      }
      kids.push(list);
    }
  }
  container.replaceChildren(...kids);
}
