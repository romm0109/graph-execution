import { Box, Text } from "ink";
import { THEME } from "./theme.js";

export const TAIL_LINES = 10;

/** The last `lines` output lines of the focused agent, in a panel titled with its label. */
export function LogTail({ label, tail, lines = TAIL_LINES }: { label?: string; tail: readonly string[]; lines?: number }) {
  const shown = tail.slice(-lines);
  return (
    <Box borderStyle="round" borderColor={THEME.faint} flexDirection="column" paddingX={1}>
      <Text>
        <Text color={THEME.accent}>▍</Text>
        <Text color={THEME.muted}>{label === undefined ? "no agent output yet" : "output of "}</Text>
        {label === undefined ? null : (
          <Text color={THEME.text} bold>
            {label}
          </Text>
        )}
      </Text>
      {shown.length === 0 && label !== undefined ? <Text color={THEME.faint}>(waiting for output)</Text> : null}
      {shown.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          <Text color={THEME.faint}>› </Text>
          <Text color={i === shown.length - 1 ? THEME.text : THEME.muted}>{line}</Text>
        </Text>
      ))}
    </Box>
  );
}
