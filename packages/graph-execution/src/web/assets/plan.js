// The plan stage of a `--content` run on the run page: the stepper's `plan` step, the plan panel and the planned
// spec and task list. The helpers that decide what to show are pure (tested in plan.test.ts without a DOM).
import { renderMarkdown } from "./markdown.js";

/** Plan statuses where the run is still in its plan stage (the stepper's first step is current). */
const STAGE = ["planning", "needs-info", "awaiting-approval"];

/** The stepper's steps: `plan` first when the run has a plan stage. */
export function planPhases(phases, plan) {
  return plan ? ["plan", ...phases] : phases;
}

/**
 * The stepper index while the run is in its plan stage (also when planning failed or was aborted before a plan
 * existed): 0; else -1 (the run's own phase is current).
 */
export function planPhaseIndex(plan) {
  if (!plan) return -1;
  if (STAGE.includes(plan.status)) return 0;
  if ((plan.status === "failed" || plan.status === "aborted") && !plan.name) return 0;
  return -1;
}

/** The `plan` step's label while it is current. */
export function planStepLabel(plan) {
  if (!plan) return "plan";
  if (plan.status === "planning") return "planning";
  if (plan.status === "needs-info") return "needs info";
  if (plan.status === "awaiting-approval") return "waiting for approval";
  if (plan.status === "failed" && !plan.name) return "planning failed";
  if (plan.status === "aborted" && !plan.name) return "planning aborted";
  return "plan";
}

/** `u` when it is an http(s) URL, else undefined: other schemes (`javascript:`) never become links. */
export function safeUrl(u) {
  if (typeof u !== "string" || u === "") return undefined;
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

/** The plan's questions, each group with its ref's url (http/https only) and title. */
function questionGroups(plan, only) {
  const refs = new Map((plan.refs || []).map((r) => [r.ref, r]));
  return (plan.questions || [])
    .filter((q) => !only || q.ref === undefined || only.includes(q.ref))
    .map((q) => {
      const r = q.ref !== undefined ? refs.get(q.ref) : undefined;
      const url = r ? safeUrl(r.url) : undefined;
      return {
        ...(q.ref !== undefined ? { ref: q.ref } : {}),
        ...(url ? { url } : {}),
        ...(r && r.title ? { title: r.title } : {}),
        questions: [...q.questions],
      };
    });
}

/** The dropped refs that have no question group of their own, as groups without questions. */
function droppedGroups(plan, groups) {
  const shown = new Set(groups.map((g) => g.ref));
  const refs = new Map((plan.refs || []).map((r) => [r.ref, r]));
  return (plan.dropped || []).filter((d) => !shown.has(d)).map((d) => {
    const r = refs.get(d);
    const url = r ? safeUrl(r.url) : undefined;
    return { ref: d, ...(url ? { url } : {}), ...(r && r.title ? { title: r.title } : {}), questions: [] };
  });
}

const refLine = (r) => r.ref + (r.title ? " — " + r.title : "");

/**
 * What the plan panel shows for `plan`, as plain data: `{ title, tone, lines, questions, links, commands }`, or
 * undefined when there is nothing to show (a running plan without dropped refs).
 */
export function planPanel(plan) {
  if (!plan) return undefined;
  const base = { lines: [], questions: [], links: [], commands: [] };
  const dropped = plan.dropped || [];
  if (plan.status === "planning") {
    const lines = (plan.refs || []).map(refLine);
    if (plan.lastError) lines.push("Previous attempt rejected: " + plan.lastError);
    return { ...base, title: "Planning (attempt " + Math.max(plan.attempt || 0, 1) + "/" + plan.attempts + ")", tone: "running", lines };
  }
  if (plan.status === "needs-info") {
    const questions = questionGroups(plan);
    const lines = [];
    if (dropped.length) lines.push("Dropped: " + dropped.join(", "));
    lines.push("This run is final: answer the questions and start a new run.");
    return { ...base, title: "Needs info", tone: "warn", lines, questions };
  }
  if (plan.status === "awaiting-approval") {
    const questions = dropped.length ? questionGroups(plan, dropped) : [];
    const lines = [];
    if (dropped.length) lines.push("Dropped (not ready): " + dropped.join(", "));
    lines.push("Committed on " + plan.branch + ". The run waits for your approval.");
    if (plan.hint) lines.push(plan.hint);
    const links = [];
    if (plan.spec !== undefined) links.push({ label: "Spec (" + (plan.specRel || "docs/prd/" + plan.name + ".md") + ")", href: "#plan-spec" });
    if (plan.tasks) links.push({ label: "Tasks (" + plan.tasks.length + ")", href: "#plan-tasks" });
    return {
      ...base,
      title: "Waiting for approval: " + plan.name,
      tone: "ok",
      lines,
      questions: [...questions, ...droppedGroups(plan, questions)],
      links,
      commands: [plan.approve, plan.replan].filter(Boolean),
    };
  }
  if (plan.status === "failed" && plan.error) {
    return { ...base, title: "Planning failed", tone: "bad", lines: [plan.error] };
  }
  if (plan.status === "aborted" && !plan.name) {
    return { ...base, title: "Planning aborted", tone: "bad", lines: ["Plan it again with: graph-execution --resume" + (String(plan.branch).startsWith("graph/") ? " --run " + plan.branch.slice(6) : "")] };
  }
  if (dropped.length) {
    const questions = questionGroups(plan, dropped);
    return { ...base, title: "Dropped: " + dropped.join(", "), tone: "warn", questions: [...questions, ...droppedGroups(plan, questions)] };
  }
  return undefined;
}

/**
 * The spec split at its ATX headings (outside code fences): `{ heading, level }` blocks and `{ text }` blocks between
 * them, so headings render as headings (`renderMarkdown` has none).
 */
export function specBlocks(text) {
  const out = [];
  let buf = [];
  let fence = false;
  const flush = () => {
    if (buf.some((l) => l.trim() !== "")) out.push({ text: buf.join("\n") });
    buf = [];
  };
  for (const line of String(text).split("\n")) {
    if (/^```/.test(line)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      out.push({ heading: m[2], level: m[1].length });
    } else buf.push(line);
  }
  flush();
  return out;
}

/** "Plan stage" layout: the run has a plan and no task nodes yet (the graph is hidden). */
export function inPlanStage(s) {
  return !!s.plan && !s.graph.nodes.some((n) => !n.id.startsWith("@"));
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function refHeading(g) {
  const h = el("div", "pref");
  if (g.ref !== undefined) {
    if (g.url) {
      const a = el("a", "", g.ref);
      a.href = g.url;
      a.rel = "noopener noreferrer";
      a.target = "_blank";
      h.append(a);
    } else h.append(el("span", "", g.ref));
    if (g.title) h.append(el("span", "ptitle", " — " + g.title));
  }
  return h;
}

/** Fills `box` with the plan panel `panel` (from `planPanel`); hides it when `panel` is undefined. */
export function renderPlanPanel(box, panel) {
  const sig = panel ? JSON.stringify(panel) : "";
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.hidden = !panel;
  if (!panel) { box.replaceChildren(); return; }
  box.className = "tone-" + panel.tone;
  const kids = [];
  const head = el("div", "phead");
  head.append(el("span", "sq"), el("span", "", panel.title));
  kids.push(head);
  for (const line of panel.lines) kids.push(el("p", "pline", line));
  for (const g of panel.questions) {
    const group = el("div", "pq");
    if (g.ref !== undefined) group.append(refHeading(g));
    if (g.questions.length) {
      const ul = el("ul");
      for (const q of g.questions) ul.append(el("li", "", q));
      group.append(ul);
    }
    kids.push(group);
  }
  if (panel.links.length) {
    const links = el("div", "plinks");
    for (const l of panel.links) {
      const a = el("a", "", l.label);
      a.href = l.href;
      links.append(a);
    }
    kids.push(links);
  }
  if (panel.commands.length) {
    const cmds = el("div", "pcmds");
    const labels = ["Approve", "Ask for changes"];
    panel.commands.forEach((c, i) => {
      const row = el("div", "pcmd");
      const code = el("code", "", c);
      const copy = el("button", "", "Copy");
      copy.type = "button";
      copy.addEventListener("click", () => {
        navigator.clipboard?.writeText(c).then(() => { copy.textContent = "Copied"; }, () => {});
      });
      row.append(el("span", "plabel", labels[i] || ""), code, copy);
      cmds.append(row);
    });
    kids.push(cmds);
  }
  box.replaceChildren(...kids);
}

/**
 * Fills `box` with the planned spec (`#plan-spec`, rendered markdown) and task list (`#plan-tasks`) of a plan waiting
 * for approval; hides it otherwise.
 */
export function renderPlanDocs(box, plan) {
  const show = !!plan && plan.status === "awaiting-approval" && (plan.spec !== undefined || !!plan.tasks);
  const sig = show ? JSON.stringify([plan.spec, plan.tasks, plan.specRel, plan.tasksRel]) : "";
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.hidden = !show;
  if (!show) { box.replaceChildren(); return; }
  const kids = [];
  if (plan.tasks) {
    const sec = el("section");
    sec.id = "plan-tasks";
    sec.append(el("h2", "", "Tasks (" + plan.tasks.length + ")" + (plan.tasksRel ? " · " + plan.tasksRel : "")));
    const ol = el("ol");
    for (const t of plan.tasks) {
      const li = el("li");
      li.append(el("span", "tid", t.id), document.createTextNode(" — " + t.title));
      if (t.dependencies.length) li.append(el("span", "tdeps", " (after " + t.dependencies.join(", ") + ")"));
      ol.append(li);
    }
    sec.append(ol);
    kids.push(sec);
  }
  if (plan.spec !== undefined) {
    const sec = el("section");
    sec.id = "plan-spec";
    sec.append(el("h2", "", "Spec" + (plan.specRel ? " · " + plan.specRel : "")));
    const body = el("div", "md");
    for (const block of specBlocks(plan.spec)) {
      if (block.heading) body.append(el("h" + Math.min(block.level + 2, 6), "", block.heading));
      else {
        const part = el("div");
        // renderMarkdown escapes the text: its output is the only HTML inserted from run data.
        part.innerHTML = renderMarkdown(block.text);
        body.append(part);
      }
    }
    sec.append(body);
    kids.push(sec);
  }
  box.replaceChildren(...kids);
}
