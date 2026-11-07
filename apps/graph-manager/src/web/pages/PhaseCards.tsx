// The phase strip of a finished run (boards 12, 13): Validation, Review + live test, Fixer, Landed.
// Computed from graph-manager's cached view of the run page when there is one, else from state.json.

import type { Glyph, Tone } from "../ui/status";
import type { CachedNode, RunDetailResponse } from "../runs";

export interface PhaseCard {
  key: string;
  title: string;
  status: string;
  tone: Tone;
  detail: string;
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
  const reviewer = stepOf(view?.agents.reviewer);
  const tester = stepOf(view?.agents.tester);
  const findings = view?.summary?.findings;
  let review: Step;
  if (view && (view.agents.reviewer || view.agents.tester)) {
    if (reviewer === "failed" || tester === "failed") review = "failed";
    else if (reviewer === "running" || tester === "running") review = "running";
    else if (reviewer === "passed" || tester === "passed") review = "passed";
    else review = landedOk ? "passed" : "not reached";
  } else review = landedOk ? "passed" : "not reached";
  const reviewText = review === "passed" && findings !== undefined ? `passed · ${findings} finding${findings === 1 ? "" : "s"}` : review;
  cards.push({
    key: "review",
    title: "Review + live test",
    status: reviewText,
    tone: TONE[review],
    detail: review === "not reached" ? "—" : "reviewer + tester",
  });

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
        </div>
      ))}
    </section>
  );
}
