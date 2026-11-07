/**
 * The concurrency share of each feature that starts now; queued features are not listed (they start with share 1).
 * 4 over 3 features gives `[2, 1, 1]`; 2 over 3 gives `[1, 1]`.
 */
export function initialShares(concurrency: number, count: number): number[] {
  if (concurrency < count) return Array.from({ length: concurrency }, () => 1);
  const base = Math.floor(concurrency / count);
  const extra = concurrency % count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}
