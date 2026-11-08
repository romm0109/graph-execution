import { useLayoutEffect, useRef, useState } from "react";
import { MORE_FIELDS, emptyForm, type FormErrors, type RunOptionsForm, type Tri } from "../runOptions";
import { Segmented } from "../ui";

const TRI_OPTIONS: { value: Tri; label: string }[] = [
  { value: "default", label: "Repo default" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];
const MERGE_OPTIONS: { value: "on" | "off"; label: string }[] = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];
const VALIDATE_OPTIONS: { value: RunOptionsForm["validateAt"]; label: string }[] = [
  { value: "default", label: "Repo default" },
  { value: "task", label: "After each task" },
  { value: "end", label: "At the end" },
];

type TextField = "model" | "concurrency" | "attempts" | "fixPasses" | "validationRounds" | "idleTimeout" | "extraArgs";

const hasMore = (f: RunOptionsForm): boolean => {
  const empty = emptyForm();
  return MORE_FIELDS.some((k) => f[k] !== empty[k]);
};

/** The Start run drawer's Options section: the common options, and the rest under "More options". */
export function RunOptionsFields({ form, onChange, errors }: { form: RunOptionsForm; onChange: (f: RunOptionsForm) => void; errors: FormErrors }) {
  const [moreOpen, setMoreOpen] = useState(() => hasMore(form));
  // <details> fires "toggle" asynchronously, also for the open state React set itself. Such an echo can arrive after a
  // newer state (a workspace switch closing the group) and would reopen it: only a toggle away from the committed
  // state is the user's.
  const committedOpen = useRef(moreOpen);
  useLayoutEffect(() => {
    committedOpen.current = moreOpen;
  }, [moreOpen]);
  // A form that is not the user's own last edit was loaded (saved choices or a reset): open "More options" when it has values there.
  const [seen, setSeen] = useState(form);
  const [emitted, setEmitted] = useState<RunOptionsForm | undefined>(undefined);
  if (form !== seen) {
    setSeen(form);
    if (form !== emitted) setMoreOpen(hasMore(form));
  }

  const set = <K extends keyof RunOptionsForm>(key: K, value: RunOptionsForm[K]) => {
    const next = { ...form, [key]: value };
    setEmitted(next);
    onChange(next);
  };

  const input = (key: TextField, label: string, testId: string, extra: { placeholder?: string; inputMode?: "numeric" | "decimal"; hint?: string } = {}) => {
    const err = key === "extraArgs" ? undefined : errors[key];
    return (
      <label className="field">
        <span className="field-label">{label}</span>
        <input
          className="input mono"
          value={form[key]}
          onChange={(e) => set(key, e.target.value)}
          placeholder={extra.placeholder}
          inputMode={extra.inputMode}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={err ? true : undefined}
          data-testid={testId}
        />
        {err ? (
          <span className="field-error" data-testid={`${testId}-error`}>
            {err}
          </span>
        ) : (
          extra.hint && <span className="field-hint">{extra.hint}</span>
        )}
      </label>
    );
  };

  return (
    <fieldset className="start-run-options" data-testid="start-run-options">
      <legend className="field-label">Options</legend>
      <div className="field">
        <span className="field-label">Human review</span>
        <Segmented options={TRI_OPTIONS} value={form.humanReview} onChange={(v) => set("humanReview", v)} ariaLabel="Human review" />
      </div>
      <div className="field">
        <span className="field-label">Merge into my branch</span>
        <Segmented options={MERGE_OPTIONS} value={form.merge} onChange={(v) => set("merge", v)} ariaLabel="Merge into my branch" />
        {form.merge === "off" && <span className="field-hint">The result stays on graph/&lt;run-id&gt; (--no-merge).</span>}
      </div>
      <div className="start-run-numbers">
        {input("model", "Model", "start-run-model", { placeholder: "Provider default" })}
        {input("concurrency", "Concurrency", "start-run-concurrency", { placeholder: "Repo default", inputMode: "numeric" })}
      </div>
      <details className="start-run-more" data-testid="start-run-more" open={moreOpen} onToggle={(e) => {
          const now = e.currentTarget.open;
          if (now !== committedOpen.current) setMoreOpen(now);
        }}>
        <summary>More options</summary>
        <div className="start-run-more-body">
          <div className="start-run-numbers">
            {input("attempts", "Attempts", "start-run-attempts", { placeholder: "Repo default", inputMode: "numeric" })}
            {input("fixPasses", "Fix passes", "start-run-fix-passes", { placeholder: "Repo default", inputMode: "numeric" })}
            {input("validationRounds", "Validation rounds", "start-run-validation-rounds", { placeholder: "Repo default", inputMode: "numeric" })}
            {input("idleTimeout", "Idle timeout (min)", "start-run-idle-timeout", { placeholder: "Repo default", inputMode: "decimal" })}
          </div>
          <div className="field">
            <span className="field-label">Validate</span>
            <Segmented options={VALIDATE_OPTIONS} value={form.validateAt} onChange={(v) => set("validateAt", v)} ariaLabel="Validate" />
          </div>
          <div className="field">
            <span className="field-label">Parallel validation</span>
            <Segmented options={TRI_OPTIONS} value={form.validateParallel} onChange={(v) => set("validateParallel", v)} ariaLabel="Parallel validation" />
          </div>
          {input("extraArgs", "Extra arguments", "start-run-extra-args", { placeholder: "--flag value", hint: "Appended last, split like a shell does." })}
        </div>
      </details>
    </fieldset>
  );
}
