import { Box, Text } from "ink";
import type { PhaseChange, RunPhase } from "../runner/events.js";

const STEPS: readonly { phase: RunPhase; name: string }[] = [
  { phase: "tasks", name: "tasks" },
  { phase: "validate", name: "validate" },
  { phase: "review", name: "review" },
  { phase: "fix", name: "fixer" },
];

/** The current step's text: the review shows its round from the first re-review on, the fixer its `fix pass N/M`. */
function currentText(name: string, { phase, round = 0, fixPasses }: PhaseChange): string {
  if (phase === "review" && round > 0) return `${name} round ${round}`;
  if (phase === "fix") return `${name} · fix pass ${round}/${fixPasses ?? "?"}`;
  return name;
}

/** The phase bar (PRD §7.9): tasks → validate → review → fixer, the current step highlighted. */
export function PhaseBar({ phase }: { phase: PhaseChange }) {
  return (
    <Box gap={1}>
      {STEPS.map(({ phase: step, name }, i) => (
        <Box key={step} gap={1}>
          {i > 0 ? <Text dimColor>→</Text> : null}
          {step === phase.phase ? (
            <Text color="cyan" bold inverse>
              {` ${currentText(name, phase)} `}
            </Text>
          ) : (
            <Text dimColor>{name}</Text>
          )}
        </Box>
      ))}
      {phase.phase === "done" ? (
        <Text color="green" bold>
          ✓ done
        </Text>
      ) : null}
    </Box>
  );
}
