/** Booleans become 0/1: SQLite has no boolean (better-sqlite3 throws on one), and both drivers must store the same. */
export function normalizeParams(params: unknown[] | undefined): unknown[] {
  return (params ?? []).map((p) => (p === true ? 1 : p === false ? 0 : p));
}
