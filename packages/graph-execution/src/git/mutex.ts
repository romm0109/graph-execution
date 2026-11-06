export type MergeLock = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * A promise-chain mutex: each `fn` starts only after the previous one settled, so merges and every other operation
 * on the integration worktree never interleave (PRD §6, single-writer merges). One lock per run.
 */
export function createMergeLock(): MergeLock {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn);
    tail = result.catch(() => undefined);
    return result;
  };
}
