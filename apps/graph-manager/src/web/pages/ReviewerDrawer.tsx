import { useEffect, useId, useState, type FormEvent } from "react";
import { ApiError, post } from "../api";
import { useKey } from "../keys";
import { INSTRUCTIONS_MAX, fromForm, idFromName, repoFileFor, toForm, type BlockAt, type Reviewer, type ReviewerForm } from "../reviewers";
import { ConfirmDialog, Drawer, Kbd, Segmented } from "../ui";

const BLOCK_OPTIONS: { value: BlockAt; label: string }[] = [
  { value: "major", label: "major" },
  { value: "blocker", label: "blocker" },
  { value: "never", label: "never" },
];

const message = (err: unknown) => (err instanceof ApiError ? err.error : err instanceof Error ? err.message : String(err));

/** Add or edit one reviewer. `reviewer` undefined means "Add reviewer"; `builtin` offers Reset to built-in. */
export function ReviewerDrawer({
  open,
  reviewer,
  providers,
  builtin,
  onClose,
  onSaved,
}: {
  open: boolean;
  reviewer?: Reviewer;
  providers: string[];
  builtin: boolean;
  onClose: () => void;
  onSaved: (r: Reviewer, how: "added" | "saved" | "reset") => void;
}) {
  const isNew = reviewer === undefined;
  const [form, setForm] = useState<ReviewerForm>(() => toForm(reviewer));
  const [idTouched, setIdTouched] = useState(false);
  const [repoTouched, setRepoTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [confirmReset, setConfirmReset] = useState(false);
  const uid = useId();
  const fid = (name: string) => `${uid}-${name}`;

  useEffect(() => {
    if (!open) return;
    setForm(toForm(reviewer));
    setIdTouched(false);
    setRepoTouched(false);
    setError(undefined);
    setConfirmReset(false);
  }, [open, reviewer]);

  const set = <K extends keyof ReviewerForm>(key: K, value: ReviewerForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const onName = (name: string) =>
    setForm((f) => {
      const next = { ...f, name };
      if (isNew && !idTouched) {
        next.id = idFromName(name);
        if (!repoTouched) next.repoFile = repoFileFor(next.id);
      }
      return next;
    });

  const onId = (id: string) => {
    setIdTouched(true);
    setForm((f) => ({
      ...f,
      id,
      repoFile: repoTouched ? f.repoFile : repoFileFor(id),
    }));
  };

  const canSave = !busy && form.name.trim() !== "" && form.id.trim() !== "";

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(undefined);
    try {
      const body = fromForm(form, isNew);
      const res = isNew
        ? await post<{ reviewer: Reviewer }>("/api/reviewers", body)
        : await post<{ reviewer: Reviewer }>(`/api/reviewers/${encodeURIComponent(reviewer.id)}`, { ...body, id: reviewer.id }, "PUT");
      onSaved(res?.reviewer ?? body, isNew ? "added" : "saved");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!reviewer) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await post<{ reviewer: Reviewer }>(`/api/reviewers/reset/${encodeURIComponent(reviewer.id)}`);
      setConfirmReset(false);
      if (res?.reviewer) setForm(toForm(res.reviewer));
      onSaved(res?.reviewer ?? reviewer, "reset");
    } catch (err) {
      setConfirmReset(false);
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  useKey(
    "Ctrl+Enter",
    (e) => {
      e.preventDefault();
      void save();
    },
    { enabled: open && !confirmReset, allowInInput: true },
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void save();
  };

  const showReset = !isNew && builtin && (reviewer.id === "code" || reviewer.id === "tester");

  return (
    <Drawer
      open={open}
      title={isNew ? "Add reviewer" : `Edit ${reviewer.name}`}
      // While the reset confirm is up, Esc belongs to it (both focus traps see the key).
      onClose={() => {
        if (!confirmReset) onClose();
      }}
      testId="reviewer-drawer"
      footer={
        <>
          {showReset && (
            <button type="button" className="btn reviewer-reset-btn" data-testid="reviewer-reset" disabled={busy} onClick={() => setConfirmReset(true)}>
              Reset to built-in
            </button>
          )}
          <span className="reviewer-footer-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="reviewer-form" className="btn btn-primary" disabled={!canSave} data-testid="reviewer-save">
            {busy ? "Saving…" : isNew ? "Add" : "Save"}
            <Kbd>Ctrl ↵</Kbd>
          </button>
        </>
      }
    >
      <form id="reviewer-form" className="reviewer-form" onSubmit={onSubmit}>
        {error && (
          <p className="reviewer-error mono" role="alert" data-testid="reviewer-error">
            {error}
          </p>
        )}
        <div className="field">
          <label className="field-label" htmlFor={fid("name")}>
            Name
          </label>
          <input
            className="input"
            value={form.name}
            onChange={(e) => onName(e.target.value)}
            data-autofocus
            autoComplete="off"
            id={fid("name")}
            data-testid="reviewer-name"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={fid("id")}>
            Id
          </label>
          <input
            className="input mono"
            value={form.id}
            onChange={(e) => onId(e.target.value)}
            disabled={!isNew}
            spellCheck={false}
            autoComplete="off"
            id={fid("id")}
            aria-describedby={isNew ? fid("id-hint") : undefined}
            data-testid="reviewer-id"
          />
          {isNew && (
            <span className="field-hint" id={fid("id-hint")}>
              Fixed once the reviewer is added.
            </span>
          )}
        </div>
        <div className="field">
          <span className="reviewer-label-row">
            <label className="field-label" htmlFor={fid("instructions")}>
              Instructions
            </label>
            <span className={form.instructions.length > INSTRUCTIONS_MAX ? "reviewer-count over mono" : "reviewer-count mono"} data-testid="reviewer-count">
              {form.instructions.length} / {INSTRUCTIONS_MAX}
            </span>
          </span>
          <textarea
            className="textarea mono reviewer-instructions"
            rows={16}
            value={form.instructions}
            onChange={(e) => set("instructions", e.target.value)}
            spellCheck={false}
            id={fid("instructions")}
            data-testid="reviewer-instructions"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={fid("repo")}>
            Repo file
          </label>
          <input
            className="input mono"
            value={form.repoFile}
            onChange={(e) => {
              setRepoTouched(true);
              set("repoFile", e.target.value);
            }}
            spellCheck={false}
            autoComplete="off"
            id={fid("repo")}
            aria-describedby={fid("repo-hint")}
            data-testid="reviewer-repo-file"
          />
          <span className="field-hint" id={fid("repo-hint")}>
            Optional file at the repo root with this repo's own rules for this reviewer
          </span>
        </div>
        <div className="reviewer-pair">
          <div className="field">
            <label className="field-label" htmlFor={fid("provider")}>
              Provider
            </label>
            <select
              className="select mono"
              value={form.provider}
              onChange={(e) => set("provider", e.target.value)}
              id={fid("provider")}
              data-testid="reviewer-provider"
            >
              <option value="">run default</option>
              {providers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor={fid("model")}>
              Model
            </label>
            <input
              className="input mono"
              value={form.model}
              placeholder="run default"
              onChange={(e) => set("model", e.target.value)}
              spellCheck={false}
              autoComplete="off"
              id={fid("model")}
              data-testid="reviewer-model"
            />
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor={fid("files")}>
            Files
          </label>
          <textarea
            className="textarea mono"
            rows={3}
            value={form.files}
            placeholder={"src/**\n!src/**/*.test.ts"}
            onChange={(e) => set("files", e.target.value)}
            spellCheck={false}
            id={fid("files")}
            aria-describedby={fid("files-hint")}
            data-testid="reviewer-files"
          />
          <span className="field-hint" id={fid("files-hint")}>
            Only these changed files; ! excludes. Empty: every file
          </span>
        </div>
        <div className="field">
          <span className="field-label">Block at</span>
          <Segmented options={BLOCK_OPTIONS} value={form.blockAt} onChange={(v) => set("blockAt", v)} ariaLabel="Block at" className="reviewer-block" />
        </div>
      </form>
      <ConfirmDialog
        open={confirmReset}
        title={`Reset ${reviewer?.name ?? ""}?`}
        body="Its instructions go back to the built-in text."
        confirmLabel="Reset"
        busy={busy}
        onConfirm={() => void reset()}
        onCancel={() => setConfirmReset(false)}
      />
    </Drawer>
  );
}
