import { glyphOf, toneOf, type Glyph, type StatusKind, type Tone } from "./status";

/** The glyph of a tone: a small inline shape colored by the tone. */
export function StatusGlyph({ tone, glyph }: { tone: Tone; glyph: Glyph }) {
  return <span className={`glyph glyph-${glyph} tone-${tone}`} data-glyph={glyph} aria-hidden="true" />;
}

/** A run or task status pill: tone colors, glyph and the label (`label ?? value`). */
export function StatusBadge({ kind, value, label }: { kind: StatusKind; value: string; label?: string }) {
  const tone = toneOf(kind, value);
  const glyph = glyphOf(kind, value);
  const text = label ?? value;
  return (
    <span className={`badge tone-${tone}`} data-tone={tone}>
      <span className={`glyph glyph-${glyph}`} data-glyph={glyph} aria-hidden="true" />
      {text}
    </span>
  );
}

/** A blue pulsing dot with "live" (the run page's server is up). */
export function LiveDot({ label = "live" }: { label?: string }) {
  return (
    <span className="live-indicator" data-tone="live">
      <span className="glyph glyph-pulse" aria-hidden="true" />
      {label}
    </span>
  );
}
