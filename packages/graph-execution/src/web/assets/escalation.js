// @ts-check
// The run page's Decision tab: an open escalation, its draft resolution as a readable summary, Apply and Abort.
import { renderDiff } from "./diff.js";

/** @typedef {{id: string, question: string, context?: string, suggestedOptions?: string[]}} Question */
/** @typedef {{id: string, node: string, status: string, reason: string, evidence: string, questions: Question[], source?: string, branch?: string}} Escalation */
/** @typedef {{id: string, content: string, dependencies: string[], validate?: unknown}} Task */
/**
 * @typedef {{escalationIds: string[], action: "continue" | "change" | "abort", guidance?: string,
 *   answers?: {escalationId: string, questionId: string, answer: string}[],
 *   editTasks?: {id: string, content?: string, dependencies?: string[], validate?: unknown}[],
 *   addTasks?: Task[], removeTasks?: string[], reopen?: string[]}} Resolution
 */
/**
 * @typedef {{kind: "action", text: string}
 *   | {kind: "guidance", text: string}
 *   | {kind: "answer", escalationId: string, questionId: string, text: string}
 *   | {kind: "edit", id: string, before: string, after: string, depsBefore: string[], depsAfter: string[], validate: boolean, missing: boolean}
 *   | {kind: "add", id: string, content: string, dependencies: string[]}
 *   | {kind: "remove", id: string}
 *   | {kind: "reopen", id: string}} SummaryRow
 */

/** URLs of the escalation routes, relative to the page so it also works under a proxy sub-path. @param {string} [prefix] */
export function escalationApi(prefix = "") {
  const base = prefix ? prefix.replace(/^\/+|\/+$/g, "") + "/" : "";
  return {
    list: `${base}escalations`,
    draft: (/** @type {string} */ id) => `${base}escalations/${encodeURIComponent(id)}/draft`,
    tasks: (/** @type {string} */ id) => `${base}escalations/${encodeURIComponent(id)}/tasks`,
    resolve: `${base}escalations/resolve`,
    advisor: (/** @type {string} */ id) => `${base}escalations/${encodeURIComponent(id)}/advisor`,
    advisorRestart: (/** @type {string} */ id) => `${base}escalations/${encodeURIComponent(id)}/advisor/restart`,
    /** The advisor terminal's WebSocket URL, resolved against the page's own URL (a proxy sub-path included). */
    advisorSocket: (/** @type {string} */ id) => {
      const u = new URL(`${base}escalations/${encodeURIComponent(id)}/advisor/terminal`, location.href);
      u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
      return u.toString();
    },
  };
}

/**
 * Loads the vendored xterm classes and the shared terminal client (dist/web/assets/vendor/xterm/, copied by the
 * postbuild; see assets/vendor/README.md). The WebGL addon is optional: without it xterm keeps its DOM renderer.
 * @returns {Promise<{mountTerminal: any, Terminal: any, FitAddon: any, WebglAddon?: any, PredictiveEchoAddon?: any}>}
 */
export async function loadTerminal() {
  // Built at run time: the files exist only in dist/ (copied by the postbuild), not next to this source.
  const at = (/** @type {string} */ p) => new URL(p, import.meta.url).href;
  // xterm's stylesheet is linked here rather than in page.html: it exists only in dist/, and only the terminal needs it.
  if (!document.querySelector("link[data-xterm]")) {
    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: at("./vendor/xterm/xterm.css") });
    link.dataset.xterm = "";
    document.head.append(link);
  }
  /** @type {any[]} */
  const [client, xterm, fit, webgl, echo] = await Promise.all([
    import(at("./terminal/client.js")),
    import(at("./vendor/xterm/xterm.mjs")),
    import(at("./vendor/xterm/addon-fit.mjs")),
    import(at("./vendor/xterm/addon-webgl.mjs")).catch(() => null),
    import(at("./vendor/xterm/xterm-zerolag-input.mjs")).catch(() => null),
  ]);
  return {
    mountTerminal: client.mountTerminal,
    Terminal: xterm.Terminal,
    FitAddon: fit.FitAddon,
    WebglAddon: webgl ? webgl.WebglAddon : undefined,
    PredictiveEchoAddon: echo ? echo.PredictiveEchoAddon : undefined,
  };
}

/** The terminal's colors from the page's theme variables. */
function terminalTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (/** @type {string} */ name, /** @type {string} */ fallback) => css.getPropertyValue(name).trim() || fallback;
  return { background: v("--deep", "#0f0f10"), foreground: v("--text", "#ededed"), cursor: v("--accent", "#7aa2ff"), selectionBackground: "rgba(122, 162, 255, 0.3)" };
}

/**
 * The message of an error body: `{ error: "text" }` or `{ error: { code, message } }` (shown as `refused (<code>): <message>`).
 * @param {any} body @param {string} [fallback]
 */
export function errorText(body, fallback = "Request failed") {
  const e = body && body.error;
  if (typeof e === "string" && e) return e;
  if (e && typeof e === "object") {
    const message = typeof e.message === "string" && e.message ? e.message : fallback;
    return typeof e.code === "string" && e.code ? `refused (${e.code}): ${message}` : message;
  }
  return fallback;
}

const ACTION = { continue: "Continue: run the escalated task(s) again with the guidance", change: "Change the tasks, then continue", abort: "Abort the run" };

/**
 * The draft as summary rows: the action, the guidance, the answers, each edited task with its content before and after,
 * then added, removed and reopened tasks.
 * @param {Resolution} draft @param {Task[]} tasksBefore the run's current task set
 * @returns {SummaryRow[]}
 */
export function summarizeDraft(draft, tasksBefore) {
  const byId = new Map(tasksBefore.map((t) => [t.id, t]));
  /** @type {SummaryRow[]} */
  const rows = [{ kind: "action", text: ACTION[draft.action] || draft.action }];
  if (draft.guidance && draft.guidance.trim()) rows.push({ kind: "guidance", text: draft.guidance.trim() });
  for (const a of draft.answers || []) rows.push({ kind: "answer", escalationId: a.escalationId, questionId: a.questionId, text: a.answer });
  for (const e of draft.editTasks || []) {
    const t = byId.get(e.id);
    const before = t ? t.content : "";
    const depsBefore = t ? [...t.dependencies] : [];
    rows.push({
      kind: "edit",
      id: e.id,
      before,
      after: e.content === undefined ? before : e.content,
      depsBefore,
      depsAfter: e.dependencies === undefined ? depsBefore : [...e.dependencies],
      validate: e.validate !== undefined,
      missing: !t,
    });
  }
  for (const t of draft.addTasks || []) rows.push({ kind: "add", id: t.id, content: t.content, dependencies: [...(t.dependencies || [])] });
  for (const id of draft.removeTasks || []) rows.push({ kind: "remove", id });
  for (const id of draft.reopen || []) rows.push({ kind: "reopen", id });
  return rows;
}

/**
 * A line diff of two texts as one hunk with every line (task contents are short), in diff.js's parsed shape.
 * @param {string} path @param {string} before @param {string} after
 * @returns {import("./diff.js").ParsedFile}
 */
export function lineDiff(path, before, after) {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  // LCS lengths of the suffixes a[i..] and b[j..], in a flat table.
  const n = a.length, m = b.length, w = m + 1;
  const lcs = new Array((n + 1) * w).fill(0);
  /** @param {number} i @param {number} j @returns {number} */
  const at = (i, j) => lcs[i * w + j] ?? 0;
  /** @param {number} i */
  const left = (i) => a[i] ?? "";
  /** @param {number} j */
  const right = (j) => b[j] ?? "";
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i * w + j] = left(i) === right(j) ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  }
  /** @type {import("./diff.js").DiffLine[]} */
  const lines = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && left(i) === right(j)) { lines.push({ kind: "ctx", old: i + 1, new: j + 1, text: left(i) }); i++; j++; }
    else if (i < n && (j >= m || at(i + 1, j) >= at(i, j + 1))) { lines.push({ kind: "del", old: i + 1, text: left(i) }); i++; }
    else { lines.push({ kind: "add", new: j + 1, text: right(j) }); j++; }
  }
  return { path, status: "M", binary: false, hunks: lines.length ? [{ oldStart: n ? 1 : 0, oldLines: n, newStart: m ? 1 : 0, newLines: m, header: "", lines }] : [] };
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
/** @param {string} cls @param {string} text */
const span = (cls, text) => Object.assign(document.createElement("span"), { className: cls, textContent: text });
/** @param {string[]} ids */
const idList = (ids) => (ids.length ? ids.join(", ") : "none");

/**
 * @param {HTMLElement} tabEl the Decision tab's body
 * @param {HTMLElement} footerEl the panel's sticky footer, for Apply and Abort
 * @param {{id: string, runId?: string, onDone?: () => void, onSelect?: (id: string) => void, api?: ReturnType<typeof escalationApi>,
 *   terminal?: typeof loadTerminal}} opts the `terminal` loader is replaced in tests
 * @returns {{id: string, refresh(hint?: {draft?: number, open?: string[], advisor?: string}): Promise<void>, destroy(): void}}
 */
export function mountEscalation(tabEl, footerEl, { id, runId, onDone, onSelect, api = escalationApi(), terminal = loadTerminal }) {
  let destroyed = false;
  /** @type {Escalation[]} */
  let records = [];
  /** @type {{draft: Resolution | null, error?: string} | null} */
  let draft = null;
  /** @type {Task[]} */
  let tasks = [];
  /** @type {number | undefined} */
  let draftCounter;
  let openSig = "";
  let loadError = "";
  let busy = false;
  const barErr = para("err", "");

  /** @param {string} url */
  async function getJson(url) {
    const res = await fetch(url);
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new Error(errorText(body, "Request failed (" + res.status + ")"));
    return body;
  }
  async function loadRecords() {
    records = (await getJson(api.list)).escalations || [];
  }
  async function loadDraft() {
    const [d, t] = await Promise.all([getJson(api.draft(id)), getJson(api.tasks(id)).catch(() => ({ tasks }))]);
    draft = d;
    tasks = t.tasks || [];
  }
  async function load(what = { records: true, draft: true }) {
    try {
      await Promise.all([what.records ? loadRecords() : null, what.draft ? loadDraft() : null]);
      loadError = "";
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
    if (!destroyed) render();
  }

  // ---- The advisor terminal. Its element lives across renders, so the terminal in it stays attached. ----
  const advisorBox = div("advisor");
  advisorBox.id = "advisor-" + id;
  const advisorBar = div("advisor-bar");
  const advisorMsg = para("advisor-msg", "");
  const termHost = div("advisor-term");
  termHost.hidden = true;
  advisorBox.append(advisorBar, advisorMsg, termHost);
  /** @type {{destroy(): void, fit(): void, focus(): void} | null} */
  let term = null;
  let mounting = false;
  let advisorBusy = false;

  function renderAdvisorBar() {
    const b = button(term ? "Restart" : "Talk to an agent", () => void startAdvisor(!!term));
    b.id = term ? "advisor-restart" : "advisor-start";
    b.disabled = advisorBusy;
    if (!term) b.className = "primary";
    advisorBar.replaceChildren(b);
  }

  /** @param {boolean} restart */
  async function startAdvisor(restart) {
    advisorBusy = true;
    advisorMsg.textContent = "";
    renderAdvisorBar();
    try {
      const res = await fetch(restart ? api.advisorRestart(id) : api.advisor(id), { method: "POST" });
      let body = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      if (!res.ok) {
        const e = body && body.error;
        // `unavailable` (no node-pty, no interactive mode) is shown as is: it says what to do instead.
        advisorMsg.textContent = e && e.code === "unavailable" && e.message ? e.message : errorText(body, "Request failed (" + res.status + ")");
        return;
      }
      await mountAdvisor();
    } catch {
      advisorMsg.textContent = "Request failed: disconnected";
    } finally {
      advisorBusy = false;
      if (!destroyed) renderAdvisorBar();
    }
  }

  /** Shows the terminal and attaches it to the advisor (the server replays its output). */
  async function mountAdvisor() {
    if (term || mounting || destroyed) return;
    mounting = true;
    try {
      const t = await terminal();
      if (destroyed || term) return;
      termHost.hidden = false;
      term = t.mountTerminal(termHost, {
        url: () => api.advisorSocket(id),
        Terminal: t.Terminal,
        FitAddon: t.FitAddon,
        WebglAddon: t.WebglAddon,
        PredictiveEchoAddon: t.PredictiveEchoAddon,
        instantEcho: true,
        focus: true,
        theme: terminalTheme,
        onExit: (/** @type {number} */ code) => { advisorMsg.textContent = "The agent exited (code " + code + "). Restart starts a new session."; },
        onRestart: () => { advisorMsg.textContent = ""; },
      });
    } catch (err) {
      advisorMsg.textContent = "The terminal could not be loaded: " + (err instanceof Error ? err.message : String(err));
    } finally {
      mounting = false;
      if (!destroyed) renderAdvisorBar();
    }
  }
  renderAdvisorBar();

  /** @param {Resolution} body */
  async function post(body) {
    busy = true;
    renderBar();
    try {
      const res = await fetch(api.resolve, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      let json = null;
      try { json = await res.json(); } catch { /* not JSON */ }
      if (res.ok) { barErr.textContent = ""; if (onDone) onDone(); return; }
      barErr.textContent = errorText(json, "Request failed (" + res.status + ")");
    } catch {
      barErr.textContent = "Request failed: disconnected";
    } finally {
      busy = false;
      if (!destroyed) renderBar();
    }
  }

  function renderBar() {
    const valid = !!(draft && draft.draft) && !(draft && draft.error);
    const apply = button("Apply resolution", () => { if (draft && draft.draft) post(draft.draft); });
    apply.id = "apply-resolution";
    apply.className = "primary";
    apply.disabled = !valid || busy;
    if (!valid) apply.title = draft && draft.error ? "The draft is refused or invalid" : "No draft to apply yet";
    const abort = button("Abort run", () => {
      if (confirm("Abort the run? Running agents are stopped; graph/" + (runId || "<run-id>") + " is kept.")) {
        post({ escalationIds: [id], action: "abort" });
      }
    });
    abort.id = "abort-run";
    abort.className = "abort";
    abort.disabled = busy;
    const bar = div("rvbar escbar");
    bar.append(apply, abort);
    footerEl.replaceChildren(bar, barErr);
  }

  /** @param {Escalation} rec */
  function renderRecord(rec) {
    const who = rec.node === "fixer" ? "(fixer)" : "(task " + rec.node + ")";
    /** @type {HTMLElement[]} */
    const kids = [heading("Decision needed — " + rec.id + " " + who), para("reason", rec.reason)];
    kids.push(heading("Evidence"), para("evidence", rec.evidence));
    kids.push(heading(rec.questions.length === 1 ? "Question" : "Questions"));
    const list = document.createElement("ol");
    list.className = "questions";
    for (const q of rec.questions) {
      const li = document.createElement("li");
      li.append(div("q", q.question));
      if (q.context) li.append(div("qctx", q.context));
      if (q.suggestedOptions && q.suggestedOptions.length) {
        const chips = div("chips");
        for (const o of q.suggestedOptions) chips.append(span("chip", o));
        li.append(chips);
      }
      const answer = draft && draft.draft && (draft.draft.answers || []).find((a) => a.escalationId === rec.id && a.questionId === q.id);
      if (answer) li.append(div("qanswer", "Draft answer: " + answer.answer));
      li.dataset.question = q.id;
      list.append(li);
    }
    kids.push(list);
    return kids;
  }

  function renderOthers() {
    const others = records.filter((r) => r.status === "open" && r.id !== id);
    if (!others.length) return [];
    const box = div("others");
    for (const o of others) {
      const b = button(o.id + " · " + (o.node === "fixer" ? "fixer" : "task " + o.node) + ": " + o.reason, () => { if (onSelect) onSelect(o.id); });
      b.className = "link";
      b.dataset.escalation = o.id;
      box.append(b);
    }
    return [heading("Other open escalations"), box];
  }

  function renderDraft() {
    const box = div("draft");
    box.append(heading("Draft resolution"));
    const d = draft && draft.draft;
    if (!d) {
      box.append(para("none", "No draft yet. Talk to an agent, or write <runDir>/escalations/" + id + "/draft.json."));
    } else {
      for (const row of summarizeDraft(d, tasks)) box.append(renderRow(row));
    }
    if (draft && draft.error) box.append(para("err", draft.error));
    return box;
  }

  /** @param {SummaryRow} row */
  function renderRow(row) {
    switch (row.kind) {
      case "action": return div("action", row.text);
      case "guidance": return Object.assign(document.createElement("blockquote"), { className: "guidance", textContent: row.text });
      case "answer": return div("answer", "Answer to " + row.escalationId + " " + row.questionId + ": " + row.text);
      case "edit": {
        const box = div("task edit");
        box.dataset.task = row.id;
        box.append(div("thead", "Edit task " + row.id + (row.missing ? " (unknown task)" : "")));
        if (row.before !== row.after) {
          const pre = document.createElement("pre");
          renderDiff(pre, lineDiff(row.id, row.before, row.after));
          box.append(pre);
        } else box.append(div("meta", "Content unchanged"));
        if (row.depsBefore.join(",") !== row.depsAfter.join(",")) {
          box.append(div("deps", "Dependencies: " + idList(row.depsBefore) + " → " + idList(row.depsAfter)));
        }
        if (row.validate) box.append(div("meta", "Validation commands changed"));
        return box;
      }
      case "add": {
        const box = div("task add");
        box.dataset.task = row.id;
        box.append(div("thead", "Add task " + row.id + " (after " + idList(row.dependencies) + ")"), para("content", row.content));
        return box;
      }
      case "remove": return Object.assign(div("task remove", "Remove task " + row.id), { title: "removed from the run" });
      case "reopen": return div("task reopen", "Reopen task " + row.id + " (it runs again on top of the current result)");
    }
    return div("");
  }

  function render() {
    // Moving the advisor box back into the tab blurs the terminal: give it the focus back so typing goes on.
    const focused = !!term && advisorBox.contains(document.activeElement);
    const rec = records.find((r) => r.id === id);
    /** @type {Node[]} */
    const kids = [];
    if (loadError) kids.push(para("err", loadError));
    if (rec) kids.push(...renderRecord(rec));
    else if (!loadError) kids.push(para("none", "Loading " + id + "…"));
    kids.push(...renderOthers());
    kids.push(heading("Talk to an agent"), advisorBox);
    kids.push(renderDraft());
    tabEl.replaceChildren(...kids);
    renderBar();
    if (focused && term) term.focus();
  }

  render();
  void load();

  return {
    id,
    /** Refetches the draft when its counter changed, and the records when the open escalations changed. */
    async refresh(hint = {}) {
      const sig = (hint.open || []).join(",");
      const what = { records: sig !== openSig, draft: hint.draft !== draftCounter };
      openSig = sig;
      draftCounter = hint.draft;
      // A reload while the advisor runs: attach at once, the replay restores its output.
      if (hint.advisor === "running" && !term) void mountAdvisor();
      if (what.records || what.draft) await load(what);
    },
    destroy() {
      destroyed = true;
      if (term) term.destroy();
      term = null;
      tabEl.replaceChildren();
      footerEl.replaceChildren();
    },
  };
}
