import { useEffect, useRef, useState } from "react";
import { api, ApiError, post } from "../api";
import type { ForgeRepoEntry, ProjectEntry, RepoRef } from "../types";
import { ForgeChip } from "../ui/ForgeChip";
import { useFocusTrap } from "../ui/focus";
import { Kbd } from "../ui/Kbd";

/** The server's rule for a project name (src/server/projects.ts). */
export const PROJECT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** The id the server makes from a name: the folder is `.projects/<id>`. */
export const projectIdOf = (name: string) => name.toLowerCase().replace(/_/g, "-");

const SEARCH_DEBOUNCE_MS = 200;
const sameRepo = (a: RepoRef, b: RepoRef) => a.forge === b.forge && a.owner === b.owner && a.name === b.name;
const pathOf = (r: RepoRef) => `${r.owner}/${r.name}`;

/**
 * New project (name + repositories) or Edit repos (the name is fixed). The repositories come from the forge search
 * (`GET /api/repos?q=`), of one forge: once one is picked, results of the other forge are hidden. Picked ones show as
 * chips (so a pick survives a new search) and are sent in the order they were picked.
 */
export function ProjectDialog({
  open,
  mode,
  project,
  onCancel,
  onSaved,
}: {
  open: boolean;
  mode: "new" | "edit";
  /** The project to edit (mode "edit"). */
  project?: ProjectEntry;
  onCancel(): void;
  onSaved(saved: ProjectEntry): void;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<RepoRef[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ForgeRepoEntry[]>([]);
  const [forges, setForges] = useState<{ github: boolean; gitlab: boolean } | undefined>(undefined);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useFocusTrap(ref, open, onCancel);
  useEffect(() => {
    if (!open) return;
    setName(mode === "edit" ? (project?.name ?? "") : "");
    setPicked(mode === "edit" ? [...(project?.repos ?? [])] : []);
    setQuery("");
    setBusy(false);
    setError("");
  }, [open, mode, project?.id]);

  // The forge search, debounced; a late answer for an older query is dropped.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setSearching(true);
    const timer = setTimeout(() => {
      api<{ repos?: ForgeRepoEntry[]; forges?: { github: boolean; gitlab: boolean } }>(`/api/repos?q=${encodeURIComponent(query.trim())}`)
        .then((r) => {
          if (!alive) return;
          setResults(Array.isArray(r?.repos) ? r.repos : []);
          setForges(r?.forges ?? { github: false, gitlab: false });
          setSearchError("");
        })
        .catch((err: unknown) => alive && setSearchError(err instanceof ApiError ? err.error : err instanceof Error ? err.message : String(err)))
        .finally(() => alive && setSearching(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, query]);

  if (!open) return null;

  const heading = mode === "edit" ? `Edit repos of ${project?.name ?? ""}` : "New project";
  const trimmed = name.trim();
  const nameOk = PROJECT_NAME.test(trimmed);
  const forge = picked[0]?.forge;
  const shown = forge ? results.filter((r) => r.repo.forge === forge) : results;
  const noForge = forges !== undefined && !forges.github && !forges.gitlab;
  const canSave = nameOk && picked.length >= 2 && !busy;
  const isPicked = (r: RepoRef) => picked.some((p) => sameRepo(p, r));
  const toggle = (r: RepoRef, on: boolean) => setPicked((p) => (on ? (p.some((x) => sameRepo(x, r)) ? p : [...p, r]) : p.filter((x) => !sameRepo(x, r))));

  const submit = () => {
    if (!canSave) return;
    setBusy(true);
    setError("");
    const call =
      mode === "edit" && project
        ? post<ProjectEntry>(`/api/projects/${encodeURIComponent(project.id)}`, { repos: picked }, "PATCH")
        : post<ProjectEntry>("/api/projects", { name: trimmed, repos: picked });
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
          {picked.length > 0 && (
            <div className="pj-picked" data-testid="project-picked">
              {picked.map((r) => (
                <span key={`${r.forge}:${pathOf(r)}`} className="chip mono pj-picked-chip" data-testid={`project-picked-${r.forge}-${pathOf(r)}`}>
                  {pathOf(r)}
                  <button
                    type="button"
                    className="pj-picked-remove"
                    aria-label={`Remove ${pathOf(r)}`}
                    title={`Remove ${pathOf(r)}`}
                    onClick={() => toggle(r, false)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {noForge ? (
            <p className="field-hint" data-testid="project-no-forge">
              Connect GitHub or GitLab in Settings first.
            </p>
          ) : (
            <>
              <input
                className="input"
                type="search"
                placeholder="Search repositories"
                aria-label="Search repositories"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                data-autofocus={mode === "edit" ? true : undefined}
                data-testid="project-repo-search"
              />
              <div className="pj-repo-list" data-testid="project-repo-results">
                {shown.map((entry) => {
                  const r = entry.repo;
                  return (
                    <label key={`${r.forge}:${pathOf(r)}`} className="pj-repo">
                      <input
                        type="checkbox"
                        checked={isPicked(r)}
                        onChange={(e) => toggle(r, e.target.checked)}
                        data-testid={`project-repo-${r.forge}-${pathOf(r)}`}
                      />
                      <span className="mono pj-repo-name" title={entry.fullPath}>
                        {entry.fullPath}
                      </span>
                      <ForgeChip forge={r.forge} />
                    </label>
                  );
                })}
                {shown.length === 0 && <span className="muted pj-repo-empty">{searching ? "Searching…" : searchError || "No repositories found."}</span>}
              </div>
            </>
          )}
          <span className="field-hint" data-testid="project-forge-hint">
            {forge ? `Only ${forge} repositories: a project uses one forge connection.` : "Pick at least two repositories of one forge."}
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
