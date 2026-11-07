import type { Tone } from "./status";

/** A thin progress bar; `value` is 0..1 (clamped). */
export function Progress({ value, tone = "live", label }: { value: number; tone?: Tone; label?: string }) {
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return (
    <div
      className={`progress tone-${tone}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      data-tone={tone}
    >
      <div className="progress-bar" style={{ width: `${String(v * 100)}%` }} />
    </div>
  );
}
