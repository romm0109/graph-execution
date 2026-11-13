import { useEffect, useRef, useState } from "react";
import { ApiError, post } from "../api";
import type { ProjectEntry, WorkspaceEntry } from "../types";
import { ForgeChip } from "../ui/ForgeChip";
import { useFocusTrap } from "../ui/focus";
import { Kbd } from "../ui/Kbd";

/** The server's rule for a project name (src/server/projects.ts). */
export const PROJECT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** The id the server makes from a name: the folder is `.projects/<id>`. */
export const projectIdOf = (name: string) => name.toLowerCase().replace(/_/g, "-");

/**
 * New project (name + repositories) or Edit repos (the name is fixed). The repositories are the workspaces of one
 * forge: once one is checked, those of other forges are hidden. They are sent in the order they were checked.
 */
export function ProjectDialog({
  open,
  mode,
  project,
  workspaces,
  onCancel,
  onSaved,
}: {
  open: boolean;
  mode: "new" | "edit";
  /** The project to edit (mode "edit"). */
  project?: ProjectEntry;
  workspaces: WorkspaceEntry[];
  onCancel(): void;
  onSaved(saved: ProjectEntry): void;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useFocusTrap(ref, open, onCancel);
  useEffect(() => {
    if (!open) return;
    setName(mode === "edit" ? (project?.name ?? "") : "");
    // A workspace deleted since is left out: the server would not accept it.
    setPicked(mode === "edit" ? (project?.workspaces ?? []).map((w) => w.id).filter((id) => workspaces.some((w) => w.id === id)) : []);
    setBusy(false);
    setError("");
  }, [open, mode, project?.id]);
  if (!open) return null;

  const heading = mode === "edit" ? `Edit repos of ${project?.name ?? ""}` : "New project";
  const trimmed = name.trim();
  const nameOk = PROJECT_NAME.test(trimmed);
  const forge = workspaces.find((w) => w.id === picked[0])?.forge;
  const shown = forge ? workspaces.filter((w) => w.forge === forge) : workspaces;
  const canSave = nameOk && picked.length >= 2 && !busy;
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? (p.includes(id) ? p : [...p, id]) : p.filter((x) => x !== id)));

  const submit = () => {
    if (!canSave) return;
    setBusy(true);
    setError("");
    const call =
      mode === "edit" && project
        ? post<ProjectEntry>(`/api/projects/${encodeURIComponent(project.id)}`, { workspaces: picked }, "PATCH")
        : post<ProjectEntry>("/api/projects", { name: trimmed, workspaces: picked });
    call
      .then(onSaved)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.error : err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form
        ref={ref}
        className="dialog project-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        tabIndex={-1}
        data-testid="project-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 className="dialog-title">{heading}</h2>
        <label className="field">
          <span className="field-label">Name</span>
          <input
            className="input mono"
            value={name}
            maxLength={64}
            readOnly={mode === "edit"}
            aria-invalid={trimmed !== "" && !nameOk}
            onChange={(e) => setName(e.target.value)}
            data-autofocus={mode === "new" ? true : undefined}
            data-testid="project-name"
          />
          {trimmed !== "" && !nameOk ? (
            <span className="field-error" data-testid="project-name-error">
              Use letters, digits, - and _ only (64 at most).
            </span>
          ) : (
            <span className="field-hint">
              Letters, digits, - and _. The folder is <span className="mono">.projects/{nameOk ? projectIdOf(trimmed) : "<id>"}</span>.
            </span>
          )}
        </label>
        <fieldset className="pj-repos">
          <legend className="field-label">Repositories</legend>
          <div className="pj-repo-list" data-testid="project-workspaces">
            {shown.map((w) => (
              <label key={w.id} className="pj-repo">
                <input type="checkbox" checked={picked.includes(w.id)} onChange={(e) => toggle(w.id, e.target.checked)} data-testid={`project-ws-${w.id}`} />
                <span className="mono pj-repo-name" title={w.fullPath}>
                  {w.fullPath}
                </span>
                {w.forge === "github" || w.forge === "gitlab" ? <ForgeChip forge={w.forge} /> : <span className="chip">{w.forge}</span>}
              </label>
            ))}
          </div>
          <span className="field-hint" data-testid="project-forge-hint">
            {forge ? `Only ${forge} workspaces: a project uses one forge connection.` : "Pick at least two workspaces of one forge."}
          </span>
        </fieldset>
        {error && (
          <p className="field-error" role="alert" data-testid="project-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel <Kbd>Esc</Kbd>
          </button>
          <button type="submit" className="btn btn-primary" disabled={!canSave} data-testid="project-save">
            {busy && <span className="btn-spinner" aria-hidden="true" />}
            {mode === "edit" ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
