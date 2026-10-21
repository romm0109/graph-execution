import { Box, Text } from "ink";
import type { PhaseChange, RunPhase } from "../runner/events.js";
import type { NodeStatus } from "./store.js";
import { SPINNER, STATUS_COLOR, THEME } from "./theme.js";

const STEPS: readonly { phase: RunPhase | "merge"; name: string }[] = [
  { phase: "tasks", name: "tasks" },
  { phase: "validate", name: "validate" },
  { phase: "review", name: "review" },
  { phase: "fix", name: "fixer" },
  { phase: "human", name: "human review" },
  { phase: "merge", name: "apply" },
];

/** The current step's text: the review shows its round from the first re-review on, the fixer its `fix pass N/M`. */
function currentText(name: string, { phase, round = 0, fixPasses, humanRound }: PhaseChange): string {
  if (phase === "review" && round > 0) return `${name} round ${round}`;
  if (phase === "fix") return `${name} · fix pass ${round}/${fixPasses ?? "?"}${humanRound ? ` (human round ${humanRound})` : ""}`;
  return name;
}

/**
 * The phase bar (PRD §7.9): tasks → validate → review → fixer → apply, as a pipeline. Steps before the current one
 * are lit, the current one is highlighted with a spinner, later ones are dim. The apply step follows the apply node.
 */
export function PhaseBar({ phase, merge = "pending", frame = 0 }: { phase: PhaseChange; merge?: NodeStatus; frame?: number }) {
  const MERGE_STEP = STEPS.length - 1;
  const mergeOver = merge === "done" || merge === "failed" || merge === "skipped";
  // Once the review is over the merge step is current until it is over too; then every step is behind.
  const current =
    phase.phase !== "done" ? STEPS.findIndex((s) => s.phase === phase.phase) : mergeOver ? STEPS.length : MERGE_STEP;
  const mark = (i: number): string => {
    if (i === MERGE_STEP && merge === "failed") return "✖";
    if (i === MERGE_STEP && merge === "skipped") return "⊘";
    return i < current ? "◆" : "◇";
  };
  const color = (i: number): string => {
    if (i === MERGE_STEP && merge === "failed") return STATUS_COLOR.failed;
    if (i === MERGE_STEP && merge === "skipped") return THEME.muted;
    return i < current ? THEME.ok : THEME.faint;
  };
  return (
    <Box>
      {STEPS.map(({ phase: step, name }, i) => (
        <Box key={step}>
          {i > 0 ? <Text color={i <= current ? THEME.ok : THEME.faint}>{" ━━ "}</Text> : null}
          {i === current ? (
            <Text color="#0b0f14" backgroundColor={THEME.accent} bold>
              {` ${SPINNER[frame % SPINNER.length]} ${currentText(name, phase)} `}
            </Text>
          ) : (
            <Text color={color(i)} bold={i < current}>
              {`${mark(i)} ${name}`}
            </Text>
          )}
        </Box>
      ))}
      {current === STEPS.length ? (
        <Text color={THEME.ok} bold>
          {"   ✓ done"}
        </Text>
      ) : null}
    </Box>
  );
}
