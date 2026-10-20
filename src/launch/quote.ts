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
