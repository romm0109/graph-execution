/** Quote one string for POSIX `sh`: single quotes, each `'` becomes `'\''`. */
export function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Escape a string for use inside double quotes in a `.cmd` file: `%` is doubled and a
 * trailing run of backslashes is doubled so it does not escape the closing quote.
 * Throws on `"` and line breaks, which cannot be made safe for both cmd and node's argv parser.
 */
export function escapeCmd(value: string): string {
  if (/["\r\n]/.test(value)) {
    throw new Error(
      `Cannot quote a value containing a double quote or line break for cmd: ${JSON.stringify(value)}`,
    );
  }
  return value.replaceAll("%", "%%").replace(/\\+$/, (run) => run + run);
}

/** Quote one string for a Windows `.cmd` file (needs `setlocal DisableDelayedExpansion`). */
export function quoteCmd(value: string): string {
  return `"${escapeCmd(value)}"`;
}

export function quoteFor(platform: NodeJS.Platform, value: string): string {
  return platform === "win32" ? quoteCmd(value) : quotePosix(value);
}

/**
 * Arguments for `cmd.exe` that run `line` exactly as written: `/d /s /c "<line>"`, passed with
 * `windowsVerbatimArguments`. Node's own quoting gives `cmd /c "C:\a b\run.cmd"` or `cmd /c start "" "C:\a b\x"`,
 * and cmd's quote rule then strips the wrong quotes as soon as a path has a space or the line holds more than one
 * quoted part. With `/s` cmd always strips just the outer pair, so each part keeps its own quotes. `/d` skips AutoRun.
 */
export function cmdArgs(line: string): { args: string[]; windowsVerbatimArguments: true } {
  return { args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

/**
 * Quote one argument on a `cmd /c` command line. Inside quotes `&`, `|`, `<`, `>`, `^` and spaces are literal.
 * Throws on `"` and line breaks, which cannot be quoted there (no Windows path contains them).
 */
export function quoteCmdArg(value: string): string {
  if (/["\r\n]/.test(value)) {
    throw new Error(`Cannot quote a value containing a double quote or line break for cmd: ${JSON.stringify(value)}`);
  }
  return `"${value}"`;
}
