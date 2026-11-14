// Copy of packages/graph-execution/src/providers/args.ts. graph-manager keeps its own so it does not need a
// newer graph-execution/api export than the one installed next to it (an engine build without splitArgs
// failed the typecheck). Keep the two in step.

/**
 * Splits a `GRAPH_EXECUTION_<NAME>_ARGS` value into argv words with POSIX-shell-style quoting (GE-11).
 *
 * - Whitespace separates words; runs of it count as one separator.
 * - Single quotes are fully literal (a backslash inside them is just a backslash).
 * - Double quotes allow backslash-escaping of the four characters `"`, `\`, `$` and `` ` ``; any other
 *   backslash inside them is kept.
 * - Outside quotes a backslash escapes the next character.
 * - Adjacent quoted and unquoted pieces join into one word, and `""` / `''` give an empty argument.
 *
 * Nothing is ever expanded (no variables, globs or `~`): the words go to the CLI as an argv array, never
 * through a shell. A malformed value (unterminated quote, trailing backslash) throws an `Error` that names
 * the env var.
 */

const DOUBLE_QUOTE_ESCAPES = new Set(['"', "\\", "$", "`"]);

export function splitArgs(value: string | undefined, name: string): string[] {
  if (value === undefined) return [];
  const fail = (problem: string): never => {
    throw new Error(`${name}: ${problem}`);
  };
  const words: string[] = [];
  let state: "none" | "single" | "double" = "none";
  let current = "";
  let inWord = false;

  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (state === "single") {
      if (c === "'") state = "none";
      else current += c;
    } else if (state === "double") {
      if (c === '"') state = "none";
      else if (c === "\\" && i + 1 < value.length && DOUBLE_QUOTE_ESCAPES.has(value[i + 1]!)) {
        current += value[++i]!;
      } else current += c;
    } else if (/\s/.test(c)) {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
    } else {
      inWord = true;
      if (c === "'") state = "single";
      else if (c === '"') state = "double";
      else if (c === "\\") {
        if (i + 1 >= value.length) fail("trailing backslash");
        current += value[++i]!;
      } else current += c;
    }
  }

  if (state === "single") fail("unterminated single quote");
  if (state === "double") fail("unterminated double quote");
  if (inWord) words.push(current);
  return words;
}
