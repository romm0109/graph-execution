const WIDTHS = [180, 150, 200, 120];

/** Placeholder table rows for a first load (no shimmer: the pulse is the only motion). */
export function SkeletonRows({ rows = 4, header = true }: { rows?: number; header?: boolean }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading" data-testid="skeleton">
      {header && <div className="skeleton-head" />}
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i}>
          <span className="skeleton-block skeleton-pill" />
          <span className="skeleton-block" style={{ width: WIDTHS[i % WIDTHS.length] }} />
          <span style={{ flex: 1 }} />
          <span className="skeleton-block" style={{ width: 48 }} />
        </div>
      ))}
    </div>
  );
}
