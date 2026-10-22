import { div, elapsed, v } from "/assets/util.js";
import { mountDiffView } from "/assets/diffview.js";
import { createPanel } from "/assets/panel.js";
import { mountLogs } from "/assets/logs.js";
import { mountReview, reviewApi } from "/assets/review.js";
import { createDrawer, hideSummaryCard, loopBadge, progressText, renderPhaseStepper, showSummaryCard, summaryCardOpen, visiblePhases } from "/assets/shell.js";
import { createCanvas, layoutLayers, renderEdge, renderNodeCard, svg, tickElapsed as tickCards } from "/assets/graph.js";
const PHASES = ["tasks", "validate", "review", "fix", "human", "done"];
const COLOR = {
  pending: "--muted", running: "--accent", validating: "--validating", fixing: "--warn", merging: "--accent2",
  merged: "--ok", done: "--ok", failed: "--bad", skipped: "--faint", human: "--warn",
};
let state = null;
let firstError = 0;
let endedAt = 0;
let disconnected = false;
let selected = null;
let panelId = null;
let planOpen = new Set();
let view = null;

function statusText(n) {
  if (n.text) return n.text;
  if (n.status === "running" && n.attempt > 1) return "retry " + n.attempt + "/" + n.attempts;
  if (n.status === "fixing" && n.round !== undefined) return "fixing " + n.round + "/" + (n.rounds ?? "?");
  if (n.status === "validating" && n.round) return "revalidate " + n.round + "/" + (n.rounds ?? "?");
  return n.status;
}
function phaseLabel(p) {
  const round = p.round || 0;
  if (p.phase === "review") return "review round " + round;
  if (p.phase === "fix") {
    const pass = p.fixPasses === undefined ? "fix pass " + round : "fix pass " + round + "/" + p.fixPasses;
    return p.humanRound ? pass + " (human round " + p.humanRound + ")" : pass;
  }
  if (p.phase === "human") return "human review " + round;
  return p.phase;
}

function renderHeader(s) {
  document.title = "graph-execution " + s.runId;
  document.getElementById("runid").textContent = "run " + s.runId;
  document.getElementById("provider").textContent = s.provider;
  const tasks = s.graph.nodes.filter((n) => !n.id.startsWith("@"));
  const merged = tasks.filter((n) => n.view.status === "merged").length;
  document.getElementById("progress").textContent = progressText(merged, tasks.length);
  document.getElementById("pfill").style.width = (tasks.length ? Math.round((100 * merged) / tasks.length) : 0) + "%";
  const phases = visiblePhases(PHASES, s.humanReview);
  const cur = phases.indexOf(s.phase.phase);
  renderPhaseStepper(document.getElementById("phases"), phases.map((p, i) => (i === cur ? phaseLabel(s.phase) : p)), cur, s.phase.phase === "done");
}
function tickElapsed() {
  if (!state || closed) return;
  if (state.summary && !endedAt) endedAt = Date.now();
  const end = endedAt || Date.now();
  document.getElementById("elapsed").textContent = elapsed(end - state.startedAt);
  tickCards(document.getElementById("graph"));
}

const HUMAN_NODE = "@human";
/** The human review's node, between the fixer and the apply, from the wait and the last decision. */
function humanView(s) {
  const r = s.review;
  if (r && r.waiting) return { status: "human", text: "waiting for you" + (r.round > 1 ? " · " + r.round : "") };
  if (r && r.decision === "changes") return { status: "fixing", text: "changes, round " + r.round };
  if (r && r.decision === "apply") return { status: "done", text: s.mergeTarget ? "approved" : "finished" };
  if (r && r.decision === "drop") return { status: "skipped", text: "dropped" };
  if (s.summary || s.fatal) return { status: "skipped", text: "not reached" };
  return { status: "pending", text: "pending" };
}
/** The server's graph, plus the human review's node before the apply when the run pauses for one. */
function withHuman(s) {
  const { nodes, layers, parents } = s.graph;
  const merge = layers.findIndex((l) => l.includes("@merge"));
  if (!s.humanReview || merge < 0) return s.graph;
  return {
    nodes: [...nodes, { id: HUMAN_NODE, title: "human review", view: humanView(s) }],
    layers: [...layers.slice(0, merge), [HUMAN_NODE], ...layers.slice(merge)],
    parents: { ...parents, [HUMAN_NODE]: parents["@merge"] || [], "@merge": [HUMAN_NODE] },
  };
}

const canvas = createCanvas(document.getElementById("graph"), { onSelect: selectNode });
function renderGraph(s) {
  const { nodes, layers, parents } = withHuman(s);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lay = layoutLayers(layers, parents);
  const edges = svg("g");
  for (const e of lay.edges) {
    const from = byId.get(e.from), to = byId.get(e.to);
    if (!from || !to) continue;
    edges.append(renderEdge(e.points[0], e.points[1], { from: from.view.status, to: to.view.status }));
  }
  const cards = svg("g");
  const now = Date.now();
  for (const [id, p] of lay.nodes) {
    const n = byId.get(id);
    if (!n) continue;
    const text = statusText(n.view);
    cards.append(renderNodeCard(n.view, {
      id, title: n.title, x: p.x, y: p.y, provider: s.provider, now, selected: id === selected,
      retryable: (s.retryable || []).includes(id),
      detail: text !== n.view.status && !text.startsWith("retry ") ? text : undefined,
      badge: (s.retryable || []).includes(id) ? "retry" : loopBadge(n.view.loops),
      badgeClass: !(s.retryable || []).includes(id) && loopBadge(n.view.loops) ? "warn" : undefined,
    }));
  }
  canvas.root.replaceChildren(edges, cards);
  canvas.setContent(lay.width, lay.height);
}
function selectNode(id) {
  if (!state) return;
  // The human review is the panel's Review tab.
  if (id === HUMAN_NODE) {
    if (reviewCtl) { panel.open("Human review", "waiting for you"); panel.setTab("review"); }
    return;
  }
  selected = id;
  renderGraph(state);
  renderPanel(state);
}

const VERDICT = { likely_to_work: "Retry: likely to work", unlikely_to_help: "Retry: unlikely to help", unclear: "Retry: unclear" };
function para(cls, text) {
  const p = document.createElement("pre");
  if (cls) p.className = cls;
  p.textContent = text;
  return p;
}
async function onRetry(id, errBox) {
  try {
    const res = await fetch("/retry/" + encodeURIComponent(id), { method: "POST" });
    if (res.ok) { selected = null; renderGraph(state); renderPanel(state); return; }
    let msg = "Retry failed (" + res.status + ")";
    try { msg = (await res.json()).error || msg; } catch { /* keep the status */ }
    errBox.textContent = msg;
  } catch { errBox.textContent = "Retry failed: disconnected"; }
}
async function onMerge(s, errBox) {
  if (!confirm("Apply what the run has done so far to " + (s.mergeTarget || "your branch") + " as uncommitted changes and end the run?")) return;
  try {
    const res = await fetch("/merge", { method: "POST" });
    if (res.ok) { selected = null; renderGraph(state); renderPanel(state); return; }
    let msg = "Merge failed (" + res.status + ")";
    try { msg = (await res.json()).error || msg; } catch { /* keep the status */ }
    errBox.textContent = msg;
  } catch { errBox.textContent = "Merge failed: disconnected"; }
}
const fetchLines = (query) => async (path, from, to) => {
  const res = await fetch("/file?" + query + "&path=" + encodeURIComponent(path) + "&from=" + from + "&to=" + to);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
};
function failureSection(s, id, node) {
  const retryable = (s.retryable || []).includes(id);
  if (!retryable && node.view.status !== "failed") return null;
  const children = [];
  const info = (s.failures || {})[id];
  if (info) children.push(para("err", info.error));
  const sum = info && info.summary;
  if (!sum || sum.status === "unavailable") children.push(para("", "No summary available"));
  else if (sum.status === "pending") children.push(para("", "Summarizing…"));
  else {
    children.push(para("", sum.cause));
    children.push(para("verdict " + sum.verdict, VERDICT[sum.verdict] || "Retry: unclear"));
    children.push(para("", sum.why));
  }
  if (retryable) {
    const err = para("err", "");
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Retry";
    b.addEventListener("click", () => onRetry(id, err));
    children.push(b);
    if (s.mergeable) {
      const m = document.createElement("button");
      m.type = "button";
      m.textContent = "Merge into " + (s.mergeTarget || "my branch") + " as it is";
      m.addEventListener("click", () => onMerge(s, err));
      children.push(m);
    }
    children.push(err);
  } else children.push(para("", "Retry is not available for this node"));
  return children;
}

const fetchDiff = (id) => async (path) => {
  const res = await fetch("/changes/" + encodeURIComponent(id) + "?file=" + encodeURIComponent(path));
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
};
function renderPlan(box, tp) {
  const count = (verdict) => tp.cases.filter((c) => c.verdict === verdict).length;
  const blocked = count("blocked");
  const kids = [div("phdr", "Test plan, round " + tp.round + ": " + count("pass") + "/" + tp.cases.length + " passed" + (blocked ? " (" + blocked + " blocked)" : ""))];
  const badge = (cls, text) => Object.assign(document.createElement("span"), { className: "badge " + cls, textContent: text });
  for (const c of tp.cases) {
    const row = div("crow");
    const head = div("crow");
    head.append(badge("", c.priority || "-"), div("", c.id), div("ctitle", c.title || ""), badge("v-" + c.verdict, c.verdict));
    const pre = para("", c.evidence || "No evidence");
    pre.hidden = !planOpen.has(c.id);
    head.addEventListener("click", () => {
      if (planOpen.has(c.id)) { planOpen.delete(c.id); pre.hidden = true; } else { planOpen.add(c.id); pre.hidden = false; }
    });
    row.append(head, pre);
    kids.push(row);
  }
  box.replaceChildren(...kids);
}
const NODE_TABS = ["overview", "changes", "logs"];
const panel = createPanel(document.getElementById("main"));
panel.onClose(() => { selected = null; panelId = null; stopLogs(); if (state) renderGraph(state); });
// The human review's tab, first in the panel while the run waits; it opens wide, unless the user resized the panel.
let reviewCtl = null;
function syncReview(s) {
  const waiting = !!(s.review && s.review.waiting);
  if (waiting && !reviewCtl) {
    panel.addTab("review", { first: true });
    if (!selected) for (const t of NODE_TABS) panel.removeTab(t);
    reviewCtl = mountReview(panel.tab("review"), panel.footer(), {
      api: reviewApi(""),
      context: () => ({ applyLabel: state && state.mergeTarget ? "Apply" : "Finish", target: (state && state.mergeTarget) || "your branch", dropNote: "it stays on graph/" + (state && state.runId) }),
    });
    if (!panel.userSized()) panel.setWidth(Math.max(innerWidth * 0.6, 640));
    panel.open("Human review", "waiting for you");
    panel.setTab("review");
  } else if (!waiting && reviewCtl) {
    reviewCtl.destroy();
    reviewCtl = null;
    panel.removeTab("review");
    if (!selected) panel.close();
  }
  if (reviewCtl) reviewCtl.refresh({ round: s.review.round });
}
let panelEls = null;
let panelSig = "";
// ---- Logs tab: the selected node's logs; the server pushes `log` events to the subscribed SSE connection ----
let logsCtl = null;
let clientId = null;
let logSub = null;
function stopLogs() { if (logsCtl) logsCtl.destroy(); logsCtl = null; }
function postSub() {
  if (!clientId) return;
  fetch("/logs/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: clientId, labels: logSub ? logSub.labels : [], offsets: logSub ? logSub.offsets : {} }) }).catch(() => {});
}
const logsApi = (id) => ({
  async list() {
    const r = await fetch("/logs?node=" + encodeURIComponent(id));
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()).logs;
  },
  subscribe(labels, onChunk, offsets) {
    const sub = { labels: labels.slice(0, 16), onChunk, offsets };
    logSub = sub;
    postSub();
    // A re-subscribe replaces this one at once; only a real unsubscribe clears the server side.
    return () => setTimeout(() => { if (logSub === sub) { logSub = null; postSub(); } }, 0);
  },
  async full(label) {
    const r = await fetch("/logs/" + encodeURIComponent(label) + "?full=1");
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  },
});
function renderPanel(s) {
  const id = selected;
  const node = id && s.graph.nodes.find((n) => n.id === id);
  if (!node) {
    selected = null;
    panelId = null;
    panelSig = "";
    stopLogs();
    for (const t of NODE_TABS) panel.removeTab(t);
    if (!reviewCtl) panel.close();
    return;
  }
  for (const t of NODE_TABS) panel.addTab(t);
  // Skip the rebuild when nothing this node's tabs show has changed (the server pushes every event, log line and tick).
  const sig = JSON.stringify([node.title, node.view, (s.failures || {})[id], (s.retryable || []).includes(id), s.mergeable, s.mergeTarget]);
  if (panelId === id && sig === panelSig) return;
  panelSig = sig;
  if (panelId !== id) {
    panelId = id;
    if (view) view.destroy();
    view = null;
    const files = div("changes");
    panelEls = { info: div("info"), fail: div("fail"), plan: div("plan"), totals: div("totals"), none: div("none", "No changes yet"), list: files };
    panel.tab("overview").replaceChildren(panelEls.info, panelEls.fail, panelEls.plan);
    panel.tab("changes").replaceChildren(panelEls.totals, panelEls.none, files);
    stopLogs();
    logsCtl = mountLogs(panel.tab("logs"), logsApi(id));
    planOpen = new Set();
    for (const t of ["overview", "changes", "logs"]) panel.tab(t).scrollTop = 0;
  }
  const { info, fail, plan, totals, none, list } = panelEls;
  panel.open(node.title, { text: statusText(node.view), color: v(COLOR[node.view.status]) });
  {
    const nv = node.view;
    const rows = [["Status", statusText(nv)], ["Agent", s.provider]];
    if (nv.attempts) rows.push(["Attempts", (nv.attempt || 1) + " / " + nv.attempts]);
    if (nv.startedAt) rows.push(["Elapsed", elapsed((nv.endedAt || Date.now()) - nv.startedAt)]);
    if (nv.loops) rows.push(["Loop stops", nv.loops + " — " + (nv.lastLoop || "")]);
    const tot = nv.changes && nv.changes.total;
    if (tot) rows.push(["Changes", tot.files + (tot.files === 1 ? " file" : " files") + " +" + tot.added + " −" + tot.deleted]);
    info.replaceChildren(...rows.map(([k, val]) => {
      const row = div("row", "");
      row.append(Object.assign(document.createElement("b"), { textContent: k + ": " }), document.createTextNode(String(val)));
      return row;
    }));
  }
  const fsec = failureSection(s, id, node);
  fail.hidden = !fsec;
  if (fsec) fail.replaceChildren(...fsec);
  const ch = node.view.changes;
  const files = (ch && ch.files) || [];
  const tp = node.view.testPlan;
  plan.hidden = !tp;
  if (tp) renderPlan(plan, tp);
  none.hidden = files.length > 0;
  totals.hidden = files.length === 0;
  if (ch && files.length) {
    totals.replaceChildren(
      document.createTextNode(ch.total.files + (ch.total.files === 1 ? " file " : " files ")),
      Object.assign(document.createElement("span"), { className: "add", textContent: "+" + ch.total.added }),
      document.createTextNode(" "),
      Object.assign(document.createElement("span"), { className: "del", textContent: "−" + ch.total.deleted }),
    );
  }
  if (!view) {
    view = mountDiffView(list, { files, loadDiff: fetchDiff(id), loadLines: fetchLines("node=" + encodeURIComponent(id)) });
    view.setWidth(panel.el.offsetWidth);
  } else view.update(files);
}
new ResizeObserver(() => { if (view) view.setWidth(panel.el.offsetWidth); }).observe(panel.el);

const drawer = createDrawer(document.getElementById("drawer"), { storageKey: "ge.drawer" });
function eventRow(e) {
  const row = document.createElement("div");
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = e.time;
  row.append(t, document.createTextNode(e.text));
  return row;
}
function renderEvents(s) {
  const box = document.getElementById("events");
  const atEnd = drawer.body.scrollTop + drawer.body.clientHeight >= drawer.body.scrollHeight - 4;
  box.replaceChildren(...s.events.map(eventRow));
  if (atEnd) drawer.scrollToEnd();
  const last = s.events[s.events.length - 1];
  drawer.setStrip(last ? eventRow(last) : "");
}

const APPLIED = "Applied as uncommitted changes to";
const SUMMARY_COLOR = { green: "--ok", yellow: "--warn", red: "--bad" };
const SUMMARY_MARK = { green: "✔", yellow: "▲", red: "✖" };
function changeLine(line) {
  const pre = document.createElement("pre");
  const m = /^(\s*\+\d+) (-\d+\s*) (.*)$/.exec(line);
  if (!m) { pre.textContent = line; return pre; }
  const add = document.createElement("span");
  add.className = "add";
  add.textContent = m[1];
  const del = document.createElement("span");
  del.className = "del";
  del.textContent = m[2];
  pre.append(add, " ", del, " " + m[3]);
  return pre;
}
let summaryShown = false;
function renderSummary(s) {
  const c = s.summaryContent;
  const btn = document.getElementById("summarybtn");
  btn.hidden = !c;
  if (!c) { summaryShown = false; hideSummaryCard(); return; }
  const box = document.createElement("div");
  box.id = "summary";
  const title = document.createElement("div");
  title.className = "stitle";
  title.style.color = v(SUMMARY_COLOR[c.color]);
  title.textContent = SUMMARY_MARK[c.color] + " " + c.title;
  box.append(title);
  for (const section of c.sections) {
    if (section.heading) {
      const h = document.createElement("h3");
      h.textContent = section.heading;
      box.append(h);
    }
    const applied = section.heading && section.heading.startsWith(APPLIED);
    for (const line of section.lines) {
      if (applied) { box.append(changeLine(line)); continue; }
      const pre = document.createElement("pre");
      pre.textContent = line;
      box.append(pre);
    }
  }
  // Shown once when the run ends; after a dismissal only the top bar's button reopens it.
  if (!summaryShown || summaryCardOpen()) { summaryShown = true; showSummaryCard(box); }
  lastSummary = box;
}
let lastSummary = null;
let closed = false;
let source = null;
let timer = null;
async function onAction() {
  if (!state) return;
  if (!state.summary && !state.fatal) {
    if (!confirm("Abort the run? Running agents are killed; the state is kept and the run can be resumed.")) return;
    try { await fetch("/abort", { method: "POST" }); } catch { /* the page shows Disconnected */ }
    return;
  }
  try {
    const res = await fetch("/close", { method: "POST" });
    if (!res.ok) return;
  } catch { return; }
  closed = true;
  if (source) source.close();
  if (timer) clearInterval(timer);
  document.body.replaceChildren(Object.assign(document.createElement("p"), {
    textContent: "Server closed. Reopen with `graph-execution open` (only while a run is live).",
    style: "padding: 16px",
  }));
}
function renderAction(s) {
  const b = document.getElementById("action");
  if (!b) return;
  b.hidden = false;
  const ended = !!s.summary || !!s.fatal;
  b.textContent = ended ? "Close" : "Abort";
  b.className = ended ? "" : "abort";
}

function render(s) {
  state = s;
  renderAction(s);
  renderSummary(s);
  renderHeader(s);
  renderGraph(s);
  renderPanel(s);
  syncReview(s);
  renderEvents(s);
  tickElapsed();
}
function showConn() {
  if (closed) return;
  const conn = document.getElementById("conn");
  conn.textContent = disconnected ? "Disconnected" : "";
  conn.classList.toggle("off", disconnected);
}

async function main() {
  document.getElementById("action").addEventListener("click", onAction);
  document.getElementById("summarybtn").addEventListener("click", () => { if (lastSummary) showSummaryCard(lastSummary); });
  try {
    const res = await fetch("/state");
    render(await res.json());
  } catch { /* the event stream retries */ }
  const es = new EventSource("/events");
  source = es;
  es.addEventListener("state", (ev) => {
    firstError = 0;
    disconnected = false;
    showConn();
    render(JSON.parse(ev.data));
  });
  es.addEventListener("hello", (ev) => { clientId = JSON.parse(ev.data).id; postSub(); });
  es.addEventListener("log", (ev) => { if (logSub) logSub.onChunk(JSON.parse(ev.data)); });
  es.onerror = () => {
    const now = Date.now();
    if (!firstError) firstError = now;
    disconnected = true;
    showConn();
    if (now - firstError >= 60000) es.close();
  };
  // EventSource retries on its own; make sure we also give up after a minute without a message.
  timer = setInterval(() => {
    if (firstError && Date.now() - firstError >= 60000) es.close();
    tickElapsed();
  }, 1000);
}
main();
