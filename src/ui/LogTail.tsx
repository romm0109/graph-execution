import { Box, Text } from "ink";

export const TAIL_LINES = 10;

/** The last `lines` output lines of the focused agent. */
export function LogTail({ label, tail, lines = TAIL_LINES }: { label?: string; tail: readonly string[]; lines?: number }) {
  const shown = tail.slice(-lines);
  return (
    <Box borderStyle="single" borderColor="gray" flexDirection="column" paddingX={1}>
      <Text dimColor>{label === undefined ? "no agent output yet" : `output of ${label}`}</Text>
      {shown.length === 0 && label !== undefined ? <Text dimColor>(waiting for output)</Text> : null}
      {shown.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
}
