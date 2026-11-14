// The phase strip of a finished run (boards 12, 13): Validation, Review + live test, Fixer, Landed.
// Computed from graph-manager's cached view of the run page when there is one, else from state.json.

import type { Glyph, Tone } from "../ui/status";
import type { CachedNode, CachedReviewer, RunDetailResponse } from "../runs";

export interface PhaseCard {
  key: string;
  title: string;
  status: string;
  tone: Tone;
  detail: string;
  /** One row per reviewer of the run (Review + live test card); unset for views cached before KAN-87. */
  rows?: PhaseCardRow[];
}

export interface PhaseCardRow {
  id: string;
  name: string;
  status: string;
  tone: Tone;
  /** `N blocker · N major · N minor` once the run is over. */
  counts?: string;
}

type Step = "passed" | "failed" | "running" | "not reached" | "skipped";

const RUNNING = new Set(["running", "validating", "fixing", "merging"]);

function stepOf(n: CachedNode | undefined): Step {
  if (!n) return "not reached";
  if (n.status === "done" || n.status === "merged") return "passed";
  if (n.status === "failed") return "failed";
  if (n.status === "skipped") return "skipped";
  if (RUNNING.has(n.status)) return "running";
  return "not reached";
}

const GLYPH: Record<Tone, Glyph> = { ok: "dot", bad: "diamond", live: "pulse", mute: "dashed", warn: "half", rev: "half" };

const TONE: Record<Step, Tone> = { passed: "ok", failed: "bad", running: "live", "not reached": "mute", skipped: "mute" };

/** The cards, left to right. A run whose tasks failed gets a Tasks card first and no Landed card (board 12). */
export function phaseCards(detail: RunDetailResponse, fullPath: string): PhaseCard[] {
  const runStatus = detail.state?.status ?? detail.summary.status;
  const view = detail.view;
  const tasks = detail.tasks ?? [];
  const failedTasks = tasks.filter((t) => t.status === "failed");
  const landedOk = runStatus === "applied" || runStatus === "done";
  const cards: PhaseCard[] = [];

  if (failedTasks.length > 0) {
    const first = failedTasks[0]!;
    const status =
      failedTasks.length === 1
        ? `${first.id} failed after ${first.attempts} attempt${first.attempts === 1 ? "" : "s"}`
        : `${failedTasks.map((t) => t.id).join(", ")} failed`;
    cards.push({ key: "tasks", title: "Tasks", status, tone: "bad", detail: first.error?.split("\n")[0] ?? "—" });
  }

  // Validation.
  let validation: Step;
  if (view?.gate) {
    validation = stepOf(view.gate);
    // The engine skips the gate when the tasks failed; on a landed run a skipped or unseen gate passed.
    if (validation === "skipped" || validation === "not reached") validation = landedOk ? "passed" : "not reached";
  } else if (landedOk) validation = "passed";
  else if (runStatus === "failed") validation = failedTasks.length > 0 ? "not reached" : "failed";
  else if (runStatus === "running" && tasks.length > 0 && tasks.every((t) => t.status === "merged")) validation = "running";
  else validation = "not reached";
  cards.push({
    key: "validation",
    title: "Validation",
    status: validation,
    tone: TONE[validation],
    detail: validation === "not reached" ? "—" : view?.gate ? "typecheck · lint" : "validation commands",
  });

  // Review + live test.
  // Views cached before KAN-87 have no reviewer list: the built-in code reviewer and live tester.
  const legacy: CachedReviewer[] = [
    { id: "code", title: "code reviewer", node: view?.agents.reviewer },
    { id: "tester", title: "live tester", node: view?.agents.tester },
  ].flatMap((r) => (r.node ? [{ ...r, node: r.node }] : []));
  const reviewers = view?.reviewers;
  const list = reviewers ?? legacy;
  const steps = list.map((r) => stepOf(r.node));
  const findings = view?.summary?.findings;
  let review: Step;
  if (reviewers && reviewers.length === 0) review = "skipped";
  else if (steps.includes("failed")) review = "failed";
  else if (steps.includes("running")) review = "running";
  else if (steps.includes("passed")) review = "passed";
  else review = landedOk ? "passed" : "not reached";
  const reviewText = review === "passed" && findings !== undefined ? `passed · ${findings} finding${findings === 1 ? "" : "s"}` : review;
  const names = reviewers ? reviewers.map((r) => r.title) : ["code reviewer", "live tester"];
  const reviewCard: PhaseCard = {
    key: "review",
    title: "Review + live test",
    status: reviewText,
    tone: TONE[review],
    detail: review === "not reached" ? "—" : review === "skipped" ? "no reviewers enabled" : names.join(" + "),
  };
  if (reviewers) {
    reviewCard.rows = reviewers.map((r, i) => {
      const step = steps[i]!;
      const row: PhaseCardRow = { id: r.id, name: r.title, status: step, tone: TONE[step] };
      if (r.findings) row.counts = `${r.findings.blocker} blocker · ${r.findings.major} major · ${r.findings.minor} minor`;
      return row;
    });
  }
  cards.push(reviewCard);

  // Fixer.
  const fixer = view?.agents.fixer;
  const fixerStep = stepOf(fixer);
  const budget = view?.summary?.fixPasses ?? view?.phase.fixPasses;
  const ran = fixer !== undefined && fixerStep !== "not reached" && fixerStep !== "skipped";
  const used = fixer?.round ?? fixer?.rounds ?? (ran ? (fixer?.attempt ?? 1) : 0);
  const passes = `${used} / ${budget ?? "?"} passes`;
  if (!view && landedOk) {
    cards.push({ key: "fixer", title: "Fixer", status: "—", tone: "mute", detail: "fix passes" });
  } else if (review === "not reached" || (review === "running" && !ran)) {
    cards.push({ key: "fixer", title: "Fixer", status: "not reached", tone: "mute", detail: budget !== undefined ? `0 / ${budget} passes` : "—" });
  } else {
    const tone: Tone = fixerStep === "running" ? "live" : runStatus === "applied" || runStatus === "done" ? "ok" : fixerStep === "failed" || runStatus === "failed" ? "bad" : "warn";
    const fixed = landedOk && ran && findings !== undefined && findings > 0 ? `${findings} finding${findings === 1 ? "" : "s"} fixed` : undefined;
    cards.push({ key: "fixer", title: "Fixer", status: fixerStep === "running" ? `running · ${passes}` : passes, tone, detail: fixed ?? `${used} / ${budget ?? "?"} passes` });
  }

  // Landed.
  if (failedTasks.length === 0) {
    const landed = detail.landed;
    if (runStatus === "applied") {
      cards.push({
        key: "landed",
        title: "Landed",
        status: landed ? `${landed.files} file${landed.files === 1 ? "" : "s"} uncommitted` : "applied",
        tone: "ok",
        detail: landed ? `+${landed.added} −${landed.deleted} in ${fullPath}` : fullPath,
      });
    } else if (runStatus === "done") {
      const target = view?.summary?.merge?.target;
      cards.push({ key: "landed", title: "Landed", status: "landed", tone: "mute", detail: target ? `merged into ${target}` : "—" });
    } else if (runStatus === "failed" || runStatus === "aborted") {
      cards.push({ key: "landed", title: "Landed", status: "not landed", tone: "bad", detail: view?.summary?.abort?.message.split("\n")[0] ?? "—" });
    } else {
      cards.push({ key: "landed", title: "Landed", status: "pending", tone: "mute", detail: "—" });
    }
  }
  return cards;
}

export function PhaseCards({ detail, fullPath }: { detail: RunDetailResponse; fullPath: string }) {
  const cards = phaseCards(detail, fullPath);
  return (
    <section className="phase-cards" aria-label="Phases" data-testid="phase-cards">
      {cards.map((c) => (
        <div key={c.key} className="phase-card" data-testid={`phase-${c.key}`} data-tone={c.tone}>
          <span className="phase-card-title">
            <span className={`glyph glyph-${GLYPH[c.tone]} tone-${c.tone}`} aria-hidden="true" />
            {c.title}
          </span>
          <span className={`phase-card-status tone-${c.tone}`}>{c.status}</span>
          <span className="phase-card-detail" title={c.detail}>
            {c.detail}
          </span>
          {c.rows && (
            <ul className="phase-card-rows" data-testid={`phase-${c.key}-rows`}>
              {c.rows.map((r) => (
                <li key={r.id} data-testid={`phase-reviewer-${r.id}`} title={[r.name, r.status, r.counts].filter(Boolean).join(" · ")}>
                  <span className={`glyph glyph-${GLYPH[r.tone]} tone-${r.tone}`} aria-hidden="true" />
                  <span className="phase-card-row-name">{r.name}</span>
                  <span className={`phase-card-row-status tone-${r.tone}`}>{r.status}</span>
                  {r.counts && <span className="mono">{r.counts}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}
