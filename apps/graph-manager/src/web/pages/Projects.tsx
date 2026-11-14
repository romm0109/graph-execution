import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useOverview } from "../overview";
import type { ProjectEntry } from "../types";
import { AgentIcon } from "../ui/AgentIcon";
import { ConfirmDialog } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { ForgeChip } from "../ui/ForgeChip";
import { Icon } from "../ui/Icon";
import { SkeletonRows } from "../ui/Skeleton";
import { useToast } from "../ui/toast";
import { useAgents } from "../useAgents";
import { projectList } from "../useProjects";
import { ProjectDialog } from "./ProjectDialog";
import "./Projects.css";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function TrashIcon() {
  return (
    <svg className="icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 8.6c.05.5.47.9.98.9h4.64c.51 0 .93-.4.98-.9l.7-8.6" />
    </svg>
  );
}

/** Projects (docs/prd/multi-repo.md, MR-01): named groups of workspaces of one forge, each with its own folder. */
export default function Projects() {
  const toast = useToast();
  const navigate = useNavigate();
  const agents = useAgents();
  const { workspaces, loaded } = useOverview();
  const [params, setParams] = useSearchParams();
  const newOpen = params.get("new") === "1";
  const [projects, setProjects] = useState<ProjectEntry[] | undefined>(undefined);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState<ProjectEntry | undefined>(undefined);
  const [deleting, setDeleting] = useState<ProjectEntry | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setProjects(projectList(await api<unknown>("/api/projects")));
      setLoadError("");
    } catch (err) {
      setLoadError(message(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const setNewOpen = (open: boolean) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (open) next.set("new", "1");
        else next.delete("new");
        return next;
      },
      { replace: true },
    );

  const remove = async (p: ProjectEntry) => {
    setBusy(true);
    try {
      await api(`/api/projects/${encodeURIComponent(p.id)}`, { method: "DELETE" });
      toast.show({ tone: "ok", text: `Deleted ${p.name}` });
    } catch (err) {
      toast.show({ tone: "bad", text: `Couldn’t delete ${p.name}: ${message(err)}` });
    } finally {
      setDeleting(undefined);
      setBusy(false);
      await load();
    }
  };

  const newButton = (
    <button type="button" className="btn btn-primary" onClick={() => setNewOpen(true)}>
      New project
    </button>
  );

  let body;
  if (loadError && projects === undefined) {
    body = (
      <p className="pj-error" role="alert" data-testid="projects-error">
        Couldn’t load the projects: {loadError}{" "}
        <button type="button" className="btn btn-sm" onClick={() => void load()}>
          Retry
        </button>
      </p>
    );
  } else if (!loaded || projects === undefined) {
    body = <SkeletonRows rows={3} />;
  } else if (projects.length === 0) {
    body =
      workspaces.length < 2 ? (
        <EmptyState
          icon={<Icon name="projects" size={22} />}
          title="Clone at least two repositories first"
          body="A project groups two or more workspaces of one forge."
          action={
            <Link className="btn btn-primary" to="/workspaces">
              Go to Workspaces
            </Link>
          }
        />
      ) : (
        <EmptyState
          icon={<Icon name="projects" size={22} />}
          title="No projects yet"
          body="A project groups workspaces of one forge in one folder, for specs, tasks and runs across them."
          action={newButton}
        />
      );
  } else {
    body = (
      <>
        {loadError && (
          <p className="pj-error" role="alert" data-testid="projects-error">
            Couldn’t refresh the projects: {loadError}{" "}
            <button type="button" className="btn btn-sm" onClick={() => void load()}>
              Retry
            </button>
          </p>
        )}
        <div className="pj-table-wrap">
          <div className="pj-table" role="table" aria-label="Projects">
            <div className="pj-row pj-head" role="row">
              <span role="columnheader">Forge</span>
              <span role="columnheader">Project</span>
              <span role="columnheader">Repos</span>
              <span role="columnheader" className="pj-actions-head">
                Actions
              </span>
            </div>
            {projects.map((p) => (
              <div key={p.id} role="row" className="pj-row table-row" data-testid={`project-${p.id}`}>
                <span role="cell" className="pj-forge">
                  {p.forge === "github" || p.forge === "gitlab" ? <ForgeChip forge={p.forge} /> : <span className="chip">{p.forge}</span>}
                </span>
                <span role="cell" className="pj-project">
                  <strong className="mono pj-name" title={p.name}>
                    {p.name}
                  </strong>
                  <span className="mono pj-path" title={p.path}>
                    {p.path}
                  </span>
                </span>
                <span role="cell" className="pj-repos-cell" data-testid={`project-repos-${p.id}`}>
                  {p.workspaces.map((w) => (
                    <span key={w.id} className="chip mono" title={w.fullPath}>
                      {w.repo}
                    </span>
                  ))}
                </span>
                <span role="cell" className="pj-actions">
                  <div className="pj-agents" role="group" aria-label={`Open a terminal on ${p.name}`}>
                    {agents.map((a) => {
                      const label = `Open ${a.label} on ${p.name}`;
                      return (
                        <button
                          key={a.id}
                          type="button"
                          className="btn btn-sm btn-icon pj-agent"
                          aria-label={label}
                          title={a.installed ? label : `${a.binary ?? a.id} is not installed`}
                          disabled={!a.installed}
                          data-testid={`project-agent-${p.id}-${a.id}`}
                          onClick={() => navigate(`/terminals?project=${encodeURIComponent(p.id)}&agent=${encodeURIComponent(a.id)}`)}
                        >
                          <AgentIcon agent={a.id} />
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className="btn btn-sm pj-terminal"
                      title={`Open a plain terminal on ${p.name}`}
                      data-testid={`project-terminal-${p.id}`}
                      onClick={() => navigate(`/terminals?project=${encodeURIComponent(p.id)}`)}
                    >
                      <Icon name="terminal" size={14} />
                      Terminal
                    </button>
                  </div>
                  <button type="button" className="btn btn-sm" data-testid={`project-edit-${p.id}`} onClick={() => setEditing(p)}>
                    Edit repos
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost btn-icon pj-delete"
                    aria-label={`Delete ${p.name}`}
                    title="Delete project"
                    data-testid={`project-delete-${p.id}`}
                    onClick={() => setDeleting(p)}
                  >
                    <TrashIcon />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
        <p className="pj-note">Deleting a project removes its folder only. The workspaces stay.</p>
      </>
    );
  }

  return (
    <section data-testid="page-projects" className="page projects-page">
      <header className="page-header pj-header">
        <h1>
          Projects{" "}
          <span className="mono pj-count" data-testid="project-count">
            {projects?.length ?? 0}
          </span>
        </h1>
        <span className="pj-spacer" />
        <button type="button" className="btn btn-primary" data-testid="project-new" onClick={() => setNewOpen(true)}>
          <Icon name="plus" size={14} />
          New project
        </button>
      </header>

      {body}

      <ProjectDialog
        open={newOpen || editing !== undefined}
        mode={editing ? "edit" : "new"}
        project={editing}
        workspaces={workspaces}
        onCancel={() => {
          if (editing) setEditing(undefined);
          else setNewOpen(false);
        }}
        onSaved={(saved) => {
          toast.show({ tone: "ok", text: `${editing ? "Saved" : "Created"} ${saved.name}` });
          if (editing) setEditing(undefined);
          else setNewOpen(false);
          void load();
        }}
      />
      <ConfirmDialog
        open={deleting !== undefined}
        tone="danger"
        title={deleting ? `Delete project ${deleting.name}?` : ""}
        body={deleting ? `This removes the project folder ${deleting.path} with its specs, tasks and runs. The workspaces stay.` : ""}
        confirmLabel="Delete"
        busy={busy}
        onConfirm={() => {
          if (deleting) void remove(deleting);
        }}
        onCancel={() => setDeleting(undefined)}
      />
    </section>
  );
}
