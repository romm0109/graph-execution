import { div, elapsed, span, v } from "/assets/util.js";
import { mountDiffView } from "/assets/diffview.js";
import { createPanel } from "/assets/panel.js";
import { mountLogs } from "/assets/logs.js";
import { mountReview, reviewApi } from "/assets/review.js";
import { hideSummaryCard, progressText, renderPhaseStepper, showSummaryCard, summaryCardOpen, visiblePhases } from "/assets/shell.js";
import { createCanvas, renderEdge, renderNodeCard, svg as svgEl, tickElapsed as tickCards, NODE_W, NODE_H, formatElapsed } from "/assets/graph.js";
const PHASES = ["features", "integration", "e2e", "human", "done"];
const GAP_X = 32, GAP_Y = 48, PAD = 16;
// Feature boxes: the whole graph of each feature run (tasks, then its review loop), with a title bar above.
const BOX_PAD = 14, BOX_HEAD = 34, BOX_GAP = 32, REPO_LABEL_H = 22;
const COLOR = {
  pending: "--muted", queued: "--muted", waiting: "--muted", running: "--accent", integrating: "--accent", validating: "--validating",
  fixing: "--warn", human: "--warn", merging: "--accent2", merged: "--ok", done: "--ok", applied: "--ok",
  failed: "--bad", aborted: "--bad", stopped: "--warn", excluded: "--faint", skipped: "--faint",
};
const ICON = { pending: "○", queued: "○", waiting: "○", merged: "✔", done: "✔", applied: "✔", failed: "✖", aborted: "✖", stopped: "■", excluded: "⊘", skipped: "⊘", human: "◆" };
let data = null;
let model = null;
let selected = null; // a node id, or "@feature:<name>" for a feature box
let closed = false;
let failures = 0;
let timer = null;
let lastText = null;

const $ = (id) => document.getElementById(id);
const colorOf = (status) => v(COLOR[status] || "--muted");
const truncate = (s, max) => (s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + "…");
function button(label, onClick, cls) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener("click", onClick);
  return b;
}
async function post(path, errBox) {
  const box = errBox || $("err");
  try {
    const r = await fetch(path, { method: "POST" });
    if (r.ok) box.textContent = "";
    else {
      let msg = "HTTP " + r.status;
      try { msg = (await r.json()).error || msg; } catch { /* keep the status */ }
      box.textContent = msg;
    }
  } catch { box.textContent = "Request failed: disconnected"; }
  refresh();
}

// ---- The graph model: each feature's run graph in a box, a merge per feature, then the e2e loop and the apply ----

const P = (text) => ({ status: "pending", text: text || "pending" });
const F = (text) => ({ status: "failed", text: text || "failed" });
/**
 * The nodes of a review loop (validate → code reviewer + tester → fixer, and the validation fixer once it ran) from
 * its saved progress. `round` is the review round in `review`, the fix pass in `fix`: fix pass n follows review round n-1.
 * A review round shows both agents running until each report is written.
 */
function loopNodes(r, ready, failed, fixers) {
  const nodes = { validate: P(), reviewer: P(), tester: P(), fixer: P(), gateFixer: fixers.gateFixer ? P() : null };
  if (!ready || !r) return nodes;
  const ph = r.phase, n = r.round;
  const fixerDone = fixers.fixer === "done";
  if (ph === "validate") nodes.validate = failed ? F() : { status: "validating", text: r.validationRounds ? "gate round " + (r.validationRounds + 1) : "validating" };
  else if (ph === "fix" && fixerDone) nodes.validate = failed ? F() : { status: "validating", text: "revalidate pass " + n };
  else nodes.validate = { status: "done", text: "passed" };
  if (fixers.gateFixer) nodes.gateFixer = fixers.gateFixer === "running" ? (failed ? F() : { status: "fixing", text: "fixing" }) : { status: "done", text: "done" };
  const reviewed = (report) => {
    if (ph === "validate") return P();
    if (ph === "review") return report ? { status: "done", text: "round " + n } : failed ? F("failed round " + n) : { status: "running", text: "round " + n };
    if ((ph === "done" || ph === "human") && n === 0 && !report) return { status: "skipped", text: "not run" };
    return { status: "done", text: "round " + (ph === "fix" ? n - 1 : n) };
  };
  nodes.reviewer = reviewed(r.reports.code);
  nodes.tester = reviewed(r.reports.tester);
  if (ph === "review") nodes.fixer = n > 0 ? { status: "done", text: "pass " + n } : P();
  else if (ph === "fix") nodes.fixer = failed && !fixerDone ? F("failed pass " + n) : fixerDone ? { status: "done", text: "pass " + n } : { status: "fixing", text: "fixing pass " + n };
  else if (ph === "done" || ph === "human") nodes.fixer = n > 0 ? { status: "done", text: n + (n === 1 ? " pass" : " passes") } : { status: "skipped", text: "not needed" };
  return nodes;
}
function taskText(t) {
  if (t.status === "running" && t.attempts > 1) return "retry " + t.attempts;
  return t.status;
}
function reviewLabel(phase, round) {
  if (phase === "review") return "review round " + round;
  if (phase === "fix") return "fix pass " + round;
  if (phase === "human") return "human review";
  return phase;
}
function mergeNode(s, f, allowed, conflicts, agent) {
  const merged = s.integration.merged;
  if (merged.includes(f.name)) return { status: "merged", text: "merged #" + (merged.indexOf(f.name) + 1), conflicts };
  // A conflicted merge waits on the integration agent's node, which carries the Retry.
  if (agent && agent.status !== "resolved") return { status: agent.status === "failed" ? "failed" : "merging", text: "conflict", conflicts: agent.files };
  if (s.integration.failed === f.name) return { status: "failed", text: "conflict unresolved", retry: allowed.retryIntegration, conflicts };
  if (f.status === "excluded") return { status: "skipped", text: "excluded" };
  if (s.status === "integrating" && f.status === "done" && !s.review) {
    // Merges run one at a time in finish order: the first unmerged done feature is the one merging now.
    const next = s.features.filter((x) => x.status === "done" && !merged.includes(x.name)).sort((a, b) => (a.finishedAt || "").localeCompare(b.finishedAt || ""))[0];
    if (next && next.name === f.name) return { status: "merging", text: "merging" };
  }
  return { status: f.status === "done" ? "waiting" : "pending", text: f.status === "done" ? "waiting" : "pending" };
}
/** The integration agent's node, from its last run on this feature's conflicted merge. */
function agentNode(agent, allowed, running) {
  const n = agent.files.length;
  const files = n + (n === 1 ? " file" : " files");
  if (agent.status === "resolved") return { status: "done", text: "resolved", conflicts: agent.files };
  if (agent.status === "failed") return { status: "failed", text: "gave up after " + agent.attempts, retry: allowed.retryIntegration, conflicts: agent.files };
  if (!running) return { status: "stopped", text: "stopped", conflicts: agent.files };
  return { status: "running", text: agent.attempt > 1 ? "try " + agent.attempt + "/" + agent.attempts : "resolving " + files, conflicts: agent.files };
}
/** The human review before the one apply, from the wait, its round and how the suite ended. */
function humanNode(d) {
  const s = d.suite;
  const round = (s.review && s.review.humanRound) || 0;
  if (d.reviewWaiting) return { status: "human", text: "waiting for you" + (round > 1 ? " · " + round : "") };
  // The decision comes from this suite process; after a resume only the outcome is known.
  if (d.reviewDecision === "apply") return { status: "done", text: "approved" };
  if (d.reviewDecision === "drop") return { status: "skipped", text: "dropped" };
  if (s.status === "applied") return round ? { status: "done", text: "approved" } : P();
  if (s.status === "failed" || s.status === "aborted" || s.status === "done") return { status: "skipped", text: round ? "ended" : "not reached" };
  // Back from a pause with change requests: the e2e fixer works on the comments, then the suite pauses again.
  if (round) return { status: "fixing", text: "changes, round " + round };
  return P();
}
function applyNode(s) {
  if (s.status === "applied") return { status: "applied", text: "applied" };
  if (s.status === "done") return { status: "done", text: "on " + (s.integrationBranch || "suite branch") };
  if (s.status === "failed" || s.status === "aborted") return { status: "skipped", text: s.status };
  return P();
}

function buildModel(d) {
  const s = d.suite;
  const nodes = new Map(); // id -> { title, status, text, feature?, retry?, info? }
  const parents = {};
  const boxes = [];
  const changes = d.changes || {};
  const add = (id, node, from) => {
    nodes.set(id, { ...node, changes: changes[id] });
    parents[id] = from;
  };
  const multiRepo = !!d.repos && d.repos.length > 1;
  const features = multiRepo ? d.repos.flatMap((r) => d.features.filter((f) => f.repo === r.name)) : d.features;
  for (const f of features) {
    const states = new Map(f.tasks.map((t) => [t.id, t]));
    const taskLayers = f.layers.length ? f.layers.map((l) => [...l]) : (f.tasks.length ? [f.tasks.map((t) => t.id)] : []);
    const ids = taskLayers.flat();
    const canRetry = d.allowed.retry.includes(f.name);
    for (const id of ids) {
      const t = states.get(id) || { status: "pending", attempts: 0 };
      add(f.name + "/" + id, { title: id, status: t.status, text: taskText(t), attempt: t.attempts, attempts: t.attempts, startedAt: t.startedAt, endedAt: t.endedAt, feature: f.name, retry: t.status === "failed" && canRetry }, (f.parents[id] || []).map((p) => f.name + "/" + p));
    }
    const hasChildren = new Set(Object.values(f.parents).flat());
    const sinks = ids.filter((id) => !hasChildren.has(id)).map((id) => f.name + "/" + id);
    const ready = ids.length > 0 && ids.every((id) => (states.get(id) || {}).status === "merged");
    const loop = loopNodes(f.review, ready, f.status === "failed" || f.status === "stopped", f.fixers || {});
    if (f.status === "done") for (const k of ["validate", "reviewer", "tester"]) if (loop[k].status === "pending") loop[k] = { status: "done", text: "done" };
    const k = (name) => "@" + name + "/" + f.name;
    const withRetry = (n) => ({ ...n, feature: f.name, retry: n.status === "failed" && canRetry });
    add(k("validate"), { title: "validate", ...withRetry(loop.validate) }, sinks);
    const beforeReview = loop.gateFixer ? k("gate-fixer") : k("validate");
    if (loop.gateFixer) add(k("gate-fixer"), { title: "validation fixer", ...withRetry(loop.gateFixer) }, [k("validate")]);
    add(k("reviewer"), { title: "code reviewer", ...withRetry(loop.reviewer) }, [beforeReview]);
    add(k("tester"), { title: "live tester", ...withRetry(loop.tester) }, [beforeReview]);
    add(k("fixer"), { title: "fixer", ...withRetry(loop.fixer) }, [k("reviewer"), k("tester")]);
    boxes.push({ feature: f, repo: multiRepo ? f.repo : undefined, layers: [...taskLayers.map((l) => l.map((id) => f.name + "/" + id)), [k("validate")], ...(loop.gateFixer ? [[k("gate-fixer")]] : []), [k("reviewer"), k("tester")], [k("fixer")]] });
    const agent = (s.integration.agents || {})[f.name];
    add("@merge/" + f.name, { title: "merge " + f.name, ...mergeNode(s, f, d.allowed, (d.conflicts || {})["@merge/" + f.name] || [], agent) }, [k("fixer")]);
    if (agent) add("@integration/" + f.name, { title: "integration agent", ...agentNode(agent, d.allowed, d.running) }, ["@merge/" + f.name]);
  }
  // The e2e phase on the suite branch: the same loop, run once every feature is merged.
  const integrated = s.features.every((f) => s.integration.merged.includes(f.name) || f.status === "excluded" || f.status === "failed") && s.integration.merged.length > 0 && !!s.review;
  const suiteFailed = s.status === "failed" || s.status === "aborted";
  const e2e = loopNodes(s.review, integrated, suiteFailed, { fixer: s.review && s.review.phase === "fix" ? "running" : undefined });
  add("@e2e-validate", { title: "e2e validate", ...e2e.validate }, d.features.map((f) => (nodes.has("@integration/" + f.name) ? "@integration/" : "@merge/") + f.name));
  add("@e2e-reviewer", { title: "cross-feature review", ...e2e.reviewer }, ["@e2e-validate"]);
  add("@e2e-tester", { title: "e2e tester", ...e2e.tester }, ["@e2e-validate"]);
  add("@e2e-fixer", { title: "e2e fixer", ...e2e.fixer }, ["@e2e-reviewer", "@e2e-tester"]);
  if (s.humanReview) add("@human", { title: "human review", ...humanNode(d) }, ["@e2e-fixer"]);
  const applyTitle = multiRepo ? (s.merge && d.repos.every((r) => r.startBranch) ? "apply → " + d.repos.length + " repos" : "result branches") : (s.startBranch && s.merge ? "apply → " + s.startBranch : "result branch");
  add("@apply", { title: applyTitle, ...applyNode(s) }, [s.humanReview ? "@human" : "@e2e-fixer"]);
  return { nodes, parents, boxes, multiRepo };
}

function layout(m) {
  const pos = new Map();
  const boxRects = [];
  const repoLabels = [];
  // A multi-repo suite leaves room above the boxes for the repo names.
  const top = m.multiRepo ? PAD + REPO_LABEL_H : PAD;
  let x = PAD;
  let bottom = top;
  let lastRepo;
  for (const b of m.boxes) {
    if (m.multiRepo && b.repo !== lastRepo) repoLabels.push({ name: b.repo, x });
    lastRepo = b.repo;
    const widest = Math.max(1, ...b.layers.map((l) => l.length));
    const inner = widest * NODE_W + (widest - 1) * GAP_X;
    const w = inner + BOX_PAD * 2;
    const h = BOX_HEAD + b.layers.length * NODE_H + (b.layers.length - 1) * GAP_Y + BOX_PAD;
    b.layers.forEach((layer, row) => {
      const rowW = layer.length * NODE_W + (layer.length - 1) * GAP_X;
      const x0 = x + BOX_PAD + (inner - rowW) / 2;
      layer.forEach((id, i) => pos.set(id, { x: x0 + i * (NODE_W + GAP_X), y: top + BOX_HEAD + row * (NODE_H + GAP_Y) }));
    });
    boxRects.push({ feature: b.feature, x, y: top, w, h });
    bottom = Math.max(bottom, top + h);
    x += w + BOX_GAP;
  }
  const width = Math.max(x - BOX_GAP + PAD, NODE_W * 2 + GAP_X + PAD * 2);
  // Each feature's merge sits under its box; the e2e loop and the apply are centered below them.
  let y = bottom + GAP_Y;
  for (const r of boxRects) pos.set("@merge/" + r.feature.name, { x: r.x + (r.w - NODE_W) / 2, y });
  const agents = boxRects.filter((r) => m.nodes.has("@integration/" + r.feature.name));
  if (agents.length) {
    y += NODE_H + GAP_Y;
    for (const r of agents) pos.set("@integration/" + r.feature.name, { x: r.x + (r.w - NODE_W) / 2, y });
  }
  const mid = (width - NODE_W) / 2;
  for (const row of [["@e2e-validate"], ["@e2e-reviewer", "@e2e-tester"], ["@e2e-fixer"], ...(m.nodes.has("@human") ? [["@human"]] : []), ["@apply"]]) {
    y += NODE_H + GAP_Y;
    const rowW = row.length * NODE_W + (row.length - 1) * GAP_X;
    row.forEach((id, i) => pos.set(id, { x: (width - rowW) / 2 + i * (NODE_W + GAP_X), y }));
  }
  return { pos, boxRects, repoLabels, width, height: y + NODE_H + PAD, mid };
}

const canvas = createCanvas($("graph"), { onSelect: selectNode });
function selectNode(id) {
  if (!data) return;
  // The human review is the panel's Review tab.
  if (id === "@human") {
    if (reviewCtl) { panel.open("Human review", "waiting for you"); panel.setTab("review"); }
    return;
  }
  selected = id;
  render(data);
}
function renderGraph(d) {
  model = buildModel(d);
  const { pos, boxRects, repoLabels, width, height } = layout(model);
  const now = Date.now();
  const clusters = svgEl("g");
  for (const l of repoLabels) clusters.append(svgEl("text", { class: "repo-label", x: l.x, y: PAD + 12 }, truncate(l.name, 40)));
  for (const r of boxRects) {
    const f = r.feature;
    const key = "@feature:" + f.name;
    const g = svgEl("g", { class: "cluster clickable" + (selected === key ? " sel" : ""), "data-node-id": key });
    g.append(svgEl("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 12 }));
    g.append(svgEl("text", { class: "ctitle", x: r.x + BOX_PAD, y: r.y + 22, fill: colorOf(f.status) }, (ICON[f.status] || "●") + " " + truncate(f.name, 22)));
    const merged = f.tasks.filter((t) => t.status === "merged").length;
    const time = f.startedAt ? " · " + formatElapsed(((f.endedAt || f.finishedAt && Date.parse(f.finishedAt)) || now) - f.startedAt) : "";
    g.append(svgEl("text", { class: "cmeta", x: r.x + r.w - BOX_PAD, y: r.y + 22, "text-anchor": "end" }, f.status + " · " + merged + "/" + f.tasks.length + " tasks" + time));
    clusters.append(g);
  }
  const edges = svgEl("g");
  for (const id in model.parents) {
    const to = pos.get(id);
    const dst = model.nodes.get(id);
    if (!to || !dst) continue;
    for (const pid of model.parents[id]) {
      const from = pos.get(pid);
      const src = model.nodes.get(pid);
      if (!from || !src) continue;
      edges.append(renderEdge({ x: from.x + NODE_W / 2, y: from.y + NODE_H }, { x: to.x + NODE_W / 2, y: to.y }, { from: src.status, to: dst.status, vertical: true }));
    }
  }
  const cards = svgEl("g");
  for (const [id, p] of pos) {
    const n = model.nodes.get(id);
    if (!n) continue;
    const conflict = n.conflicts && n.conflicts.length > 0 && id.startsWith("@merge/");
    cards.append(renderNodeCard(n, {
      id, title: n.title, x: p.x, y: p.y, provider: d.suite.provider, now, selected: id === selected,
      retryable: !!n.retry,
      detail: n.text !== n.status && !(n.text || "").startsWith("retry ") ? n.text : undefined,
      badge: n.retry ? "retry" : conflict ? "⚠ " + n.conflicts.length + " conflict" + (n.conflicts.length > 1 ? "s" : "") : undefined,
      badgeClass: n.retry ? "" : "warn",
    }));
  }
  canvas.root.replaceChildren(clusters, edges, cards);
  canvas.setContent(width, height);
}

// ---- Header, phase bar, summary ----

function currentPhase(d) {
  const s = d.suite;
  if (s.status === "applied" || s.status === "done") return "done";
  if (d.reviewWaiting) return "human";
  if (s.review) return "e2e";
  if (s.status === "integrating" || s.integration.merged.length) return "integration";
  return "features";
}
function renderHeader(d) {
  const s = d.suite;
  document.title = "graph-execution " + s.suiteId;
  $("suiteid").textContent = s.suiteId;
  $("provider").textContent = s.provider;
  const done = d.features.filter((f) => f.status === "done").length;
  $("progress").textContent = progressText(done, d.features.length);
  $("pfill").style.width = (d.features.length ? Math.round((100 * done) / d.features.length) : 0) + "%";
  const phases = visiblePhases(PHASES, s.humanReview);
  const cur = phases.indexOf(currentPhase(d));
  const ended = s.status === "failed" || s.status === "aborted";
  const labels = phases.map((p) => (p === "done" ? (s.status === "applied" ? "applied" : s.status === "done" ? "done" : ended ? s.status : "apply") : p));
  renderPhaseStepper($("phases"), labels, cur, cur === phases.length - 1);
  if (ended) $("phases").children[cur].classList.add("bad");
  $("start").hidden = !d.allowed.integrate;
  const action = $("action");
  action.hidden = false;
  action.textContent = d.running ? "Abort" : "Close";
  action.className = d.running ? "abort" : "";
}
function tickElapsed() {
  if (!data || closed) return;
  if (!data.running && !data.endedAt) data.endedAt = Date.now();
  $("elapsed").textContent = elapsed((data.endedAt || Date.now()) - Date.parse(data.suite.createdAt));
  tickCards($("graph"));
}
function renderSummary(d) {
  const box = div("");
  box.id = "summary";
  const s = d.suite;
  const end = { applied: "--ok", done: "--ok", failed: "--bad", aborted: "--bad" }[s.status];
  $("summarybtn").hidden = !end || d.running;
  if (!end || d.running) { summaryShown = false; hideSummaryCard(); return; }
  const title = div("stitle");
  title.style.color = v(end);
  const lines = [];
  const conflicts = Object.entries(d.conflicts || {}).filter(([, c]) => c.length).map(([k, c]) => k.slice(7) + ": " + c.join(", "));
  if (s.status === "applied") {
    title.textContent = "✔ Applied as uncommitted changes to " + (s.startBranch || "your checkout");
    lines.push(s.applied.files + " files changed, merged in order: " + s.integration.merged.join(" → "));
    if (conflicts.length) lines.push("Conflicts resolved by the integration agent: " + conflicts.join("; "));
    if (s.applied.conflicts.length) lines.push("Conflicts left in your checkout: " + s.applied.conflicts.join(", "));
    lines.push("Review with `git diff`, then commit.");
  } else if (s.status === "done") {
    title.textContent = "✔ Done: the result is on " + (s.integrationBranch || "the suite branch");
    lines.push("Merged in order: " + s.integration.merged.join(" → "));
    if (conflicts.length) lines.push("Conflicts resolved by the integration agent: " + conflicts.join("; "));
  } else {
    title.textContent = "✖ Suite " + s.status;
    lines.push("Resume with: graph-execution suite --resume --run " + s.suiteId);
  }
  box.replaceChildren(title, ...lines.map((l) => Object.assign(document.createElement("pre"), { textContent: l })));
  // Shown once when the suite ends; after a dismissal only the top bar's button reopens it.
  if (!summaryShown || summaryCardOpen()) { summaryShown = true; showSummaryCard(box); }
  lastSummary = box;
}
let summaryShown = false;
let lastSummary = null;

// ---- Diffs: the same file list and diff view as the run page ----

// ---- Side panel: a feature, a task, an agent or an integration node, with its changes and logs ----

const panel = createPanel($("main"));
panel.onClose(() => { selected = null; pnl.key = null; stopLogs(); if (data) render(data); });
new ResizeObserver(() => { if (pnl.view) pnl.view.setWidth(panel.el.offsetWidth); }).observe(panel.el);
const pnl = { key: null, view: null, logs: null, sig: {} };
function stopLogs() { if (pnl.logs) pnl.logs.destroy(); pnl.logs = null; }
function featureOf(key) {
  if (!key) return null;
  if (key.startsWith("@feature:")) return key.slice(9);
  const n = model && model.nodes.get(key);
  return n && n.feature;
}
/** Where a node's agent logs are: its feature run's logs, or the suite's own (integration agent and e2e agents). */
function logSource(key) {
  const feature = featureOf(key);
  if (feature) return { feature };
  if (!key) return null;
  if (key.startsWith("@integration/")) { const label = "integration-" + key.slice(13); return { prefix: label, keep: (l) => l === label }; }
  const prefix = { "@e2e-reviewer": "code-r", "@e2e-tester": "tester-r", "@e2e-fixer": "fix" }[key];
  return prefix ? { prefix } : null;
}
/** The Logs tab's data source for one node: the list and full-log endpoints, and a dedicated SSE stream per subscription. */
function logsApi(src) {
  const feature = src.feature ? "&feature=" + encodeURIComponent(src.feature) : "";
  return {
    async list() {
      const r = await fetch("/api/logs?label=" + encodeURIComponent(src.prefix || "") + feature);
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()).logs.filter((l) => !src.keep || src.keep(l.label));
    },
    subscribe(labels, onChunk) {
      const es = new EventSource("/api/logs/stream?labels=" + labels.slice(0, 16).map(encodeURIComponent).join(",") + feature);
      es.addEventListener("log", (ev) => onChunk(JSON.parse(ev.data)));
      return () => es.close();
    },
    async full(label) {
      const r = await fetch("/api/logs/" + encodeURIComponent(label) + "?full=1" + feature);
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    },
  };
}
const fetchDiff = (key) => async (path) => {
  const r = await fetch("/api/changes?node=" + encodeURIComponent(key) + "&file=" + encodeURIComponent(path));
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};
const fetchLines = (query) => async (path, from, to) => {
  const r = await fetch("/api/file?" + query + "&path=" + encodeURIComponent(path) + "&from=" + from + "&to=" + to);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};
/** Replaces a section's children only when its content changed, so a button is never swapped under a click. */
function setSection(el, name, sig, build) {
  if (pnl.sig[name] === sig) return;
  pnl.sig[name] = sig;
  el.replaceChildren(...build());
}
const DESCRIBE = {
  validate: "Runs the task folder's validate commands on the feature's result branch. Failures go to the validation fixer.",
  "gate-fixer": "Fixes what the validation found, then validation runs again.",
  reviewer: "Reviews the feature's whole diff against its PRD and writes findings.",
  tester: "Runs the app and checks the feature against the PRD's test plan.",
  fixer: "Fixes the reviewers' blocker and major findings, then validation and the review run again.",
};
function infoOf(d, key, node, f) {
  const s = d.suite;
  const rows = [];
  const actions = [];
  if (f) {
    const ready = f.tasks.length > 0 && f.tasks.every((t) => t.status === "merged");
    rows.push("run " + f.runId + " · share " + (f.share ?? "-") + (ready && f.review ? " · " + reviewLabel(f.review.phase, f.review.round) : ""));
    const agent = /^@([a-z-]+)\//.exec(key);
    if (agent && DESCRIBE[agent[1]]) rows.push(DESCRIBE[agent[1]]);
    if (d.allowed.retry.includes(f.name)) actions.push({ text: "This feature failed. Retry resumes its run; the other features keep going.", button: ["Retry " + f.name, "/api/features/" + encodeURIComponent(f.name) + "/retry"] });
  } else if (key.startsWith("@merge/")) {
    const name = key.slice(7);
    rows.push("Merges " + name + "'s result into " + (s.integrationBranch || "the suite branch") + ", in the order the features finished. A conflict goes to the integration agent with the PRDs of the features involved.");
    const failedHere = s.integration.failed === name;
    const hasAgent = !!(s.integration.agents || {})[name];
    if (node.conflicts && node.conflicts.length) rows.push("⚠ " + (failedHere || !s.integration.merged.includes(name) ? "Conflicting files: " : "Conflicts resolved by the integration agent: ") + node.conflicts.join(", "));
    if (hasAgent) rows.push("Click the integration agent below for its diff, log and Retry.");
    // Suites recorded before the agent had its own node: the merge carries the Retry.
    else if (failedHere) actions.push({ text: "The integration agent could not resolve the conflict.", button: d.allowed.retryIntegration ? ["Retry integration", "/api/integration/retry"] : null });
  } else if (key.startsWith("@integration/")) {
    const name = key.slice(13);
    const agent = (s.integration.agents || {})[name];
    rows.push("Resolves the conflicts of merging " + name + " into " + (s.integrationBranch || "the suite branch") + ", with the PRDs of the features that changed those files. Same rules as a task merge: no conflict markers left, and a real merge commit.");
    if (agent) {
      rows.push("⚠ Conflicted files: " + agent.files.join(", "));
      rows.push("try " + agent.attempt + " of " + agent.attempts);
      if (agent.status === "failed") actions.push({ text: "The agent gave up after " + agent.attempts + " tries. The merge is left conflicted in the suite's integration worktree.", button: d.allowed.retryIntegration ? ["Retry integration", "/api/integration/retry"] : null });
    }
  } else if (key === "@apply") {
    rows.push(s.applied ? s.applied.files + " files applied, " + s.applied.conflicts.length + " conflicts left" : "Applies the combined result once, as uncommitted changes.");
  } else {
    const r = s.review;
    rows.push({ "@e2e-validate": "Validation on the combined result of all features.", "@e2e-reviewer": "Reviews the files several features changed, with every PRD.", "@e2e-tester": "Runs every feature's test plan on the combined result.", "@e2e-fixer": "Fixes the e2e findings on the suite branch." }[key] || "");
    if (r) rows.push("phase " + reviewLabel(r.phase, r.round));
  }
  return { rows, actions };
}
function renderPanel(d) {
  const key = selected;
  const featureName = featureOf(key);
  const node = key && model.nodes.get(key);
  const f = featureName && d.features.find((x) => x.name === featureName);
  if (!key || (!node && !f)) {
    selected = null;
    pnl.key = null;
    stopLogs();
    for (const t of NODE_TABS) panel.removeTab(t);
    if (!reviewCtl) panel.close();
    return;
  }
  for (const t of NODE_TABS) panel.addTab(t);
  if (pnl.key !== key) {
    pnl.key = key;
    if (pnl.view) pnl.view.destroy();
    pnl.view = null;
    pnl.sig = {};
    stopLogs();
    const files = div("changes");
    pnl.els = { info: div("info"), actions: div("actions"), totals: div("totals"), none: div("none"), list: files };
    panel.tab("overview").replaceChildren(pnl.els.info, pnl.els.actions);
    panel.tab("changes").replaceChildren(pnl.els.totals, pnl.els.none, files);
    const lsrc = logSource(key);
    if (lsrc) pnl.logs = mountLogs(panel.tab("logs"), logsApi(lsrc));
    else panel.tab("logs").replaceChildren(div("placeholder", "No agent logs for this node"));
    for (const t of ["overview", "changes", "logs"]) panel.tab(t).scrollTop = 0;
  }
  const { info, actions, totals, none, list } = pnl.els;
  const title = node ? (f ? f.name + " / " : "") + node.title : f.name;
  const status = node ? { status: node.status, text: node.text } : { status: f.status, text: f.status };
  panel.open(title, { text: status.text, color: colorOf(status.status) });
  const { rows, actions: acts } = infoOf(d, key, node, f);
  setSection(info, "info", JSON.stringify(rows) + JSON.stringify(f && !node ? f.tasks : null), () => {
    const kids = rows.filter(Boolean).map((r) => div(r.startsWith("⚠") ? "row warn" : "row", r));
    if (f && !node) {
      const ul = document.createElement("ul");
      ul.className = "tasks";
      for (const t of f.tasks) {
        const li = document.createElement("li");
        const icon = span("", (ICON[t.status] || "●") + " ");
        icon.style.color = colorOf(t.status);
        li.append(icon, t.id + " " + taskText(t) + (t.attempts > 1 ? " (" + t.attempts + " attempts)" : ""));
        ul.append(li);
      }
      kids.push(ul);
    }
    return kids;
  });
  setSection(actions, "actions", JSON.stringify(acts), () => acts.flatMap((a) => {
    const err = div("err");
    const box = div("sec", a.text);
    if (a.button) box.append(document.createElement("br"), button(a.button[0], () => post(a.button[1], err)), err);
    return [box];
  }));
  // Changes: a feature box shows nothing of its own; click a task or an agent for its diff.
  const ch = node && node.changes;
  const files = (ch && ch.files) || [];
  totals.hidden = files.length === 0;
  none.hidden = files.length > 0 || !node;
  none.textContent = "No changes";
  if (files.length) {
    totals.replaceChildren(document.createTextNode(ch.total.files + (ch.total.files === 1 ? " file " : " files ")), span("add", "+" + ch.total.added), document.createTextNode(" "), span("del", "−" + ch.total.deleted));
  }
  const conflicted = new Set((node && node.conflicts) || []);
  const shown = files.map((fl) => (conflicted.has(fl.path) ? { ...fl, conflict: true } : fl));
  if (!pnl.view) {
    pnl.view = mountDiffView(list, { files: shown, loadDiff: fetchDiff(key), loadLines: fetchLines("node=" + encodeURIComponent(key)) });
    pnl.view.setWidth(panel.el.offsetWidth);
  } else pnl.view.update(shown);
}

// ---- Human review before the single apply: the panel's Review tab, shared with the run page ----

const NODE_TABS = ["overview", "changes", "logs"];
let reviewCtl = null;
function updateReview(waiting) {
  if (waiting && !reviewCtl) {
    panel.addTab("review", { first: true });
    if (!selected) for (const t of NODE_TABS) panel.removeTab(t);
    reviewCtl = mountReview(panel.tab("review"), panel.footer(), {
      api: reviewApi("/api"),
      onDone: () => refresh(),
      context: () => ({ target: (data && data.suite && data.suite.startBranch) || "your branch", dropNote: "it stays on the suite branch" }),
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
  if (reviewCtl) reviewCtl.refresh();
}

// ---- Wiring ----

function render(d) {
  const endedAt = data && data.endedAt;
  data = d;
  if (endedAt) data.endedAt = endedAt;
  updateReview(d.reviewWaiting === true);
  renderHeader(d);
  renderSummary(d);
  renderGraph(d);
  renderPanel(d);
  tickElapsed();
}
async function refresh() {
  if (closed) return;
  try {
    const r = await fetch("/api/suite");
    if (r.status !== 200) throw new Error(String(r.status));
    failures = 0;
    $("conn").textContent = "";
    $("conn").classList.remove("off");
    // Re-render only on change, like the run page's state events: a rebuild between mousedown and mouseup loses the click.
    const text = await r.text();
    if (text !== lastText) {
      lastText = text;
      render(JSON.parse(text));
    }
  } catch {
    if (++failures >= 2) { $("conn").textContent = "Disconnected"; $("conn").classList.add("off"); }
  }
}
async function onAction() {
  if (!data) return;
  if (data.running) {
    if (!confirm("Abort the suite? Running feature runs are stopped; it can be resumed.")) return;
    return post("/api/abort");
  }
  try {
    const r = await fetch("/close", { method: "POST" });
    if (!r.ok) return;
  } catch { return; }
  closed = true;
  clearInterval(timer);
  document.body.replaceChildren(Object.assign(document.createElement("p"), { textContent: "Server closed.", style: "padding: 16px" }));
}

$("action").addEventListener("click", onAction);
$("summarybtn").addEventListener("click", () => { if (lastSummary) showSummaryCard(lastSummary); });
$("start").addEventListener("click", () => {
  if (confirm("Start the integration without the failed features?")) post("/api/integration/start");
});
refresh();
timer = setInterval(() => { refresh(); tickElapsed(); }, 1000);
