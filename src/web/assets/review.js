// @ts-check
// The human review tab shared by the run and suite pages: final diff, comments, previous rounds and the sticky decision bar.
import { mountDiffView } from "./diffview.js";
import { composerDirty, mountSelection, openComposer, openCountByFile, rangeText, renderCommentList, renderThread, threadsByRow } from "./comments.js";

/** @param {string} prefix "" for the run page, "/api" for the suite page */
export function reviewApi(prefix) {
  return {
    review: `${prefix}/review`,
    files: (/** @type {number} */ round) => `${prefix}/review/files?round=${round}`,
    diff: (/** @type {string} */ file, /** @type {number} */ round) => `${prefix}/review/diff?file=${encodeURIComponent(file)}&round=${round}`,
    lines: (/** @type {number} */ round, /** @type {string} */ file, /** @type {number} */ from, /** @type {number} */ to) =>
      `${prefix}/file?round=${round}&path=${encodeURIComponent(file)}&from=${from}&to=${to}`,
    comments: `${prefix}/review/comments`,
    comment: (/** @type {string} */ id) => `${prefix}/review/comments/${encodeURIComponent(id)}`,
    decide: (/** @type {string} */ what) => `${prefix}/review/${what}`, // apply | changes | drop
  };
}

/** Comments of `round` that are not resolved. @param {Array<{round: number, status: string}>} comments @param {number} round */
export function openCount(comments, round) {
  return comments.filter((c) => c.round === round && c.status !== "resolved").length;
}

/**
 * Labels of the decision bar. `open` is the number of open comments, `blocking` the open blocker/major findings.
 * @param {{blocking: number | unknown[], open: number, applyLabel?: string}} o
 */
export function decisionLabels({ blocking, open, applyLabel = "Apply" }) {
  const blockers = Array.isArray(blocking) ? blocking.length : blocking;
  return {
    apply: blockers > 0 ? applyLabel + " anyway" : applyLabel,
    changes: open > 0 ? `Request changes (${open})` : "Request changes",
    changesDisabled: open === 0,
  };
}

/** @param {string} cls @param {string} [text] */
const div = (cls, text) => {
  const d = document.createElement("div");
  if (cls) d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
};
/** @param {string} cls @param {string} text */
const para = (cls, text) => {
  const p = document.createElement("pre");
  if (cls) p.className = cls;
  p.textContent = text;
  return p;
};
/** @param {string} text */
const heading = (text) => Object.assign(document.createElement("h3"), { textContent: text });
/** @param {string} label @param {() => void} onClick */
function button(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

/** @returns {{filter: "open" | "resolved" | "all", thisRound: boolean}} */
function readCFilter() {
  try {
    const v = JSON.parse(sessionStorage.getItem("ge.cfilter") ?? "null");
    if (v && ["open", "resolved", "all"].includes(v.filter)) return { filter: v.filter, thisRound: !!v.thisRound };
  } catch { /* storage unavailable */ }
  return { filter: "open", thisRound: false };
}
/** @param {{filter: string, thisRound: boolean}} v */
function writeCFilter(v) {
  try { sessionStorage.setItem("ge.cfilter", JSON.stringify(v)); } catch { /* storage unavailable */ }
}

/**
 * @param {HTMLElement} tabEl the Review tab's body
 * @param {HTMLElement} footerEl the panel's sticky footer, for the decision bar
 * @param {{api: ReturnType<typeof reviewApi>, onDone?: () => void, context?: () => {applyLabel?: string, target?: string, dropNote?: string}}} opts
 * @returns {{refresh(hint?: {round?: number}): Promise<void>, busy(): boolean, destroy(): void}} busy = a composer holds unsaved text
 */
export function mountReview(tabEl, footerEl, { api, onDone, context }) {
  /** @type {any} */
  let rv = null; // GET /review
  /** @type {number | null} */
  let rendered = null; // the review round the screen was built for
  let dirty = false; // data newer than the screen, waiting for the composer to be empty
  let loading = false;
  let destroyed = false;
  /** @type {number | null} */
  let shown = null; // the round on screen; null = the current one
  let tab = "files"; // "files" | "comments"
  /** @type {{destroy(): void, setWidth(px: number): void, el: HTMLElement} | null} */
  let view = null;
  const collapsed = new Set();
  /** @type {Map<string, any>} */
  const diffs = new Map(); // "round:path" -> diff
  /** @type {Map<number, any[]>} */
  const earlierFiles = new Map();
  /** @type {Map<string, HTMLElement>} */
  const fallbacks = new Map(); // path -> where threads without a visible row go
  const barErr = para("err", "");

  const busy = () => composerDirty();

  /** @param {Response} res @param {string} fallback */
  async function failure(res, fallback) {
    let msg = fallback + " (" + res.status + ")";
    try { msg = (await res.json()).error || msg; } catch { /* keep the status */ }
    return msg;
  }
  /** A write; resolves true when the server accepted it. @param {string} method @param {string} url @param {any} body @param {HTMLElement} errBox */
  async function send(method, url, body, errBox) {
    try {
      const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      if (res.ok) { errBox.textContent = ""; return true; }
      errBox.textContent = await failure(res, "Request failed");
    } catch { errBox.textContent = "Request failed: disconnected"; }
    return false;
  }
  /** A comment write: on success the new data replaces the screen unless a composer holds text. */
  async function sendComment(/** @type {string} */ method, /** @type {string} */ url, /** @type {any} */ body, /** @type {HTMLElement} */ errBox) {
    const ok = await send(method, url, body, errBox);
    if (ok) await load(true);
    return ok;
  }

  async function load(afterWrite = false) {
    if (loading || destroyed) return;
    loading = true;
    try {
      const res = await fetch(api.review);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.files) return;
      if (rendered !== null && rendered !== data.round) { collapsed.clear(); diffs.clear(); earlierFiles.clear(); shown = null; }
      const roundChanged = rendered !== data.round;
      rv = data;
      renderBar();
      if (roundChanged || afterWrite || dirty) { dirty = true; tryRender(); }
    } catch { /* the next refresh retries */ } finally { loading = false; }
  }
  function tryRender() {
    if (!dirty || !rv || busy()) return;
    dirty = false;
    render();
  }

  const viewRound = () => shown ?? rv.round;

  /** @param {any} c @param {number} h */
  function threadFor(c, h) {
    const url = api.comment(c.id);
    /** @param {string} action @param {any} body @param {HTMLElement} err */
    const post = (action, body, err) => sendComment("POST", url + "/" + action, body, err);
    return renderThread(c, {
      editable: h === rv.round,
      outcome: (rv.outcomes || {})[c.id],
      onEdit: (body, liveCheck, e) => sendComment("PUT", url, { body, liveCheck }, e),
      onDelete: (err) => sendComment("DELETE", url, null, err),
      onResolve: (err) => post("resolve", null, err),
      onReopen: (followUp, err) => post("reopen", { followUp }, err),
    });
  }

  /** File header extras: the comment-on-file button, file threads, threads whose lines are not shown. @param {string} path @param {HTMLElement} sec @param {number} h */
  function decorateFile(path, sec, h) {
    const editable = h === rv.round;
    const extra = div("rvfile");
    const slot = div("");
    const fallback = div("");
    fallbacks.set(path, fallback);
    if (editable) {
      extra.append(button("Comment on file", () => {
        openComposer(slot, {
          title: "file " + path,
          draftKey: "ge.draft." + path + ".file",
          onSave: (body, liveCheck, err) => sendComment("POST", api.comments, { file: path, body, liveCheck }, err),
        });
      }), slot);
    }
    const byRow = threadsByRow(rv.comments.filter((/** @type {any} */ c) => c.round === h), path);
    extra.append(...(byRow["file"] || []).map((/** @type {any} */ c) => threadFor(c, h)), fallback);
    const count = openCountByFile(rv.comments, h).get(path);
    if (count) sec.querySelector(".dv-fhead")?.append(Object.assign(document.createElement("span"), { className: "ccount", textContent: "💬 " + count }));
    sec.children[0]?.after(extra);
  }

  /** Puts the line threads under their rows and (current round) makes the rows selectable. @param {string} path @param {HTMLElement} body @param {number} h */
  function afterRender(path, body, h) {
    const byRow = threadsByRow(rv.comments.filter((/** @type {any} */ c) => c.round === h), path);
    /** @type {HTMLElement[]} */
    const missing = [];
    for (const [key, list] of Object.entries(byRow)) {
      if (key === "file") continue;
      const [side, line] = key.split(":");
      const found = body.querySelector(`[data-side="${side}"][data-${side}-line="${line}"]`);
      /** @type {Element | null} */
      let prev = found && found.classList.contains("half") ? found.closest(".srow") || found : found;
      for (const c of /** @type {any[]} */ (list)) {
        const t = threadFor(c, h);
        if (prev) { prev.after(t); prev = t; } else missing.push(t);
      }
    }
    fallbacks.get(path)?.replaceChildren(...(missing.length ? [div("meta", "lines not shown")] : []), ...missing);
    if (h !== rv.round) return;
    const sel = mountSelection(body, {
      onSelect: ({ file, rows: picked, anchor: a, snippet, lastRow }) => {
        const opened = openComposer(lastRow.classList.contains("half") ? lastRow.closest(".srow") || lastRow : lastRow, {
          title: rangeText(a),
          snippet,
          suggestionText: a.side === "new" ? picked.filter((r) => r.kind !== "del").map((r) => r.text ?? "").join("\n") : undefined,
          draftKey: "ge.draft." + file + "." + a.side + "." + a.startLine + "-" + a.endLine,
          onSave: (text, liveCheck, err) => sendComment("POST", api.comments, { file, side: a.side, startLine: a.startLine, endLine: a.endLine, snippet, body: text, liveCheck }, err),
          onCancel: () => sel.clear(),
        });
        if (!opened) sel.clear();
      },
    });
  }

  /** @param {number} h @param {string} path */
  async function loadDiff(h, path) {
    const key = h + ":" + path;
    const cached = diffs.get(key);
    if (cached) return cached;
    const res = await fetch(api.diff(path, h));
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    diffs.set(key, data);
    return data;
  }
  /** @param {number} h @param {string} path @param {number} from @param {number} to */
  async function loadLines(h, path, from, to) {
    const res = await fetch(api.lines(h, path, from, to));
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }

  /** "Round 1: 3 comments · 2 addressed — view" for an earlier round. @param {number} h */
  function roundSummary(h) {
    const list = rv.comments.filter((/** @type {any} */ c) => c.round === h);
    const outcomes = rv.outcomes || {};
    const verdicts = list.map((/** @type {any} */ c) => (outcomes[c.id] || {}).verdict).filter(Boolean);
    const addressed = verdicts.filter((/** @type {string} */ v) => v === "addressed").length;
    const line = div("meta", "Round " + h + ": " + list.length + " comment" + (list.length === 1 ? "" : "s") + (verdicts.length ? " · " + addressed + " addressed · " + (verdicts.length - addressed) + " not addressed" : "") + " — ");
    line.append(button("view", () => setView(h)));
    return line;
  }
  /** @param {number} h */
  function setView(h) {
    if (composerDirty() && !confirm("Discard the comment you are writing?")) return;
    shown = h === rv.round ? null : h;
    tab = "files";
    render();
  }
  /** Opens the round and file of a comment, scrolls to its lines and flashes them. @param {any} c */
  async function jumpTo(c) {
    if (composerDirty() && !confirm("Discard the comment you are writing?")) return;
    shown = c.round === rv.round ? null : c.round;
    tab = "files";
    if (c.file) collapsed.delete(c.file);
    render();
    if (!c.file) return;
    const sel = (/** @type {string} */ q) => view && view.el.querySelector(q);
    const path = CSS.escape(c.file);
    const from = c.startLine ?? c.endLine;
    const attr = "data-" + (c.side === "old" ? "old" : "new") + "-line";
    for (let i = 0; i < 40 && !destroyed; i++) {
      const first = from === undefined ? null : sel(`[data-file="${path}"][${attr}="${from}"]`);
      if (first) {
        first.scrollIntoView({ block: "center" });
        for (let n = from; n <= c.endLine; n++) {
          const d = sel(`[data-file="${path}"][${attr}="${n}"]`);
          if (!d) continue;
          d.classList.remove("flash");
          void /** @type {HTMLElement} */ (d).offsetWidth;
          d.classList.add("flash");
          setTimeout(() => d.classList.remove("flash"), 1200);
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    sel(`.dv-file[data-file="${path}"]`)?.scrollIntoView({ block: "start" });
  }

  function render() {
    if (view) view.destroy();
    view = null;
    fallbacks.clear();
    rendered = rv.round;
    const h = viewRound();
    const editable = h === rv.round;
    const open = rv.comments.filter((/** @type {any} */ c) => c.status !== "resolved").length;
    /** @type {HTMLElement[]} */
    const kids = [heading("Waiting for your review — round " + rv.round)];
    const tabs = div("rvtabs");
    for (const [name, label] of /** @type {const} */ ([["files", "Files (" + rv.files.length + ")"], ["comments", "Comments (" + open + " open)"]])) {
      const b = button(label, () => { if (tab === name) return; if (composerDirty() && !confirm("Discard the comment you are writing?")) return; tab = name; render(); });
      if (tab === name) b.className = "on";
      tabs.append(b);
    }
    if (tab === "comments") {
      const list = div("");
      renderCommentList(list, rv.comments, rv.outcomes || {}, {
        ...readCFilter(),
        round: h,
        onFilter: (filter, thisRound) => { writeCFilter({ filter, thisRound }); render(); },
        onJump: (c) => { jumpTo(c); },
      });
      tabEl.replaceChildren(...kids, tabs, list);
      return;
    }
    const blocking = rv.blocking || [];
    if (editable && blocking.length > 0) {
      const ul = document.createElement("ul");
      for (const f of blocking) ul.append(Object.assign(document.createElement("li"), { textContent: f.id + " [" + f.severity + "] " + (f.file ? f.file + ": " : "") + f.description }));
      kids.push(para("", blocking.length + " open blocker/major finding(s):"), /** @type {any} */ (ul));
    }
    kids.push(tabs);
    const switcher = div("rvrounds");
    for (let i = 1; i <= rv.round; i++) {
      const b = button("Round " + i + (i === rv.round ? " (current)" : ""), () => setView(i));
      if (i === h) b.className = "on";
      switcher.append(b);
    }
    kids.push(switcher);
    for (let i = 1; i < rv.round; i++) if (rv.comments.some((/** @type {any} */ c) => c.round === i)) kids.push(roundSummary(i));
    const ghead = heading("General comment");
    kids.push(ghead);
    if (editable) {
      kids.push(button("Add a general comment", () => {
        openComposer(ghead, {
          title: "the whole change",
          draftKey: "ge.draft.general." + h,
          onSave: (body, liveCheck, err) => sendComment("POST", api.comments, { body, liveCheck }, err),
        });
      }));
    }
    kids.push(...rv.comments.filter((/** @type {any} */ c) => !c.file && c.round === h).map((/** @type {any} */ c) => threadFor(c, h)));
    kids.push(heading((editable ? "Final diff" : "Diff") + " — round " + h));
    const box = div("");
    let files = rv.files;
    if (!editable) {
      files = earlierFiles.get(h);
      if (!files) {
        kids.push(div("meta", "Loading…"));
        tabEl.replaceChildren(...kids);
        fetch(api.files(h)).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
          .then((d) => { earlierFiles.set(h, d.files); if (!destroyed && viewRound() === h) render(); })
          .catch(() => { if (!destroyed) tabEl.append(div("meta", "Could not load round " + h)); });
        return;
      }
    }
    kids.push(div("meta", files.length + " changed file(s)"), box);
    tabEl.replaceChildren(...kids);
    view = mountDiffView(box, {
      files, collapsed,
      loadDiff: (path) => loadDiff(h, path),
      loadLines: (path, from, to) => loadLines(h, path, from, to),
      decorate: (path, sec) => decorateFile(path, sec, h),
      onRender: (path, body) => afterRender(path, body, h),
    });
    const counts = openCountByFile(rv.comments, h);
    for (const row of box.querySelectorAll(".dv-trow")) {
      const n = counts.get(/** @type {HTMLElement} */ (row).dataset.file ?? "");
      if (n) row.append(Object.assign(document.createElement("span"), { className: "ccount", textContent: "💬 " + n }));
    }
    view.setWidth(tabEl.offsetWidth);
  }

  function renderBar() {
    const ctx = (context && context()) || {};
    const target = ctx.target || "your branch";
    const blocking = (rv.blocking || []).length;
    const open = openCount(rv.comments || [], rv.round);
    const labels = decisionLabels({ blocking, open, applyLabel: ctx.applyLabel });
    /** @param {string} what @param {any} body */
    const decide = async (what, body) => { if (await send("POST", api.decide(what), body, barErr) && onDone) onDone(); };
    const apply = button(labels.apply, () => {
      if (blocking > 0) {
        if (confirm("Apply with " + blocking + " open finding(s) to " + target + " as uncommitted changes?")) decide("apply", { force: true });
      } else decide("apply", {});
    });
    apply.id = "apply";
    const changes = button(labels.changes, () => decide("changes", {}));
    changes.id = "request-changes";
    changes.disabled = labels.changesDisabled;
    const drop = button("Drop", () => {
      if (confirm("Drop the result? Nothing is applied; " + (ctx.dropNote || "it stays on its branch") + ".")) decide("drop", {});
    });
    drop.id = "drop";
    const bar = div("rvbar");
    bar.append(apply, changes, drop);
    footerEl.replaceChildren(bar, barErr);
  }

  const resize = new ResizeObserver(() => { if (view) view.setWidth(tabEl.offsetWidth); });
  resize.observe(tabEl);
  const timer = setInterval(tryRender, 1000);

  return {
    /** Loads the review unless the round on screen is `hint.round` and nothing changed. @param {{round?: number}} [hint] */
    async refresh(hint) {
      if (hint && hint.round !== undefined && hint.round === rendered && !dirty) return;
      await load();
    },
    busy,
    destroy() {
      destroyed = true;
      clearInterval(timer);
      resize.disconnect();
      if (view) view.destroy();
      view = null;
      tabEl.replaceChildren();
      footerEl.replaceChildren();
    },
  };
}
