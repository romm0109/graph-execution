import { useRef, type KeyboardEvent } from "react";

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

/** A segmented control (radiogroup): one button per option, arrow keys move the selection. */
export function Segmented<T extends string = string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const enabled = options.filter((o) => !o.disabled);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (step === 0 || enabled.length === 0) return;
    e.preventDefault();
    const i = enabled.findIndex((o) => o.value === value);
    const next = enabled[(i + step + enabled.length) % enabled.length];
    if (!next) return;
    onChange(next.value);
    Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("[data-value]") ?? []).find((b) => b.dataset.value === next.value)?.focus();
  };
  const tabbable = options.some((o) => o.value === value && !o.disabled) ? value : enabled[0]?.value;
  return (
    <div ref={ref} className={className ? `segmented ${className}` : "segmented"} role="radiogroup" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          className="segmented-option"
          aria-checked={o.value === value}
          tabIndex={o.value === tabbable ? 0 : -1}
          disabled={o.disabled}
          data-value={o.value}
          title={o.label}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
