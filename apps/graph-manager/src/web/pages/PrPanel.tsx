// The Pull request panel of the run detail (boards 13/14, right column; 19 "PULL REQUEST · EXISTS / NOT ELIGIBLE").
// GET /api/runs/:ws/:runId/pr gives the status and the run's latest Create PR job; POST starts a job (202 {job}) whose
// steps the panel polls every second until it ends.

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { ApiError, api, post } from "../api";
import { ForgeChip } from "../ui/ForgeChip";
import { Icon } from "../ui/Icon";
import { StatusGlyph } from "../ui/StatusBadge";
import type { Glyph, Tone } from "../ui/status";
import { useToast } from "../ui/toast";
import "./PrPanel.css";

export interface PrRef {
  url: string;
  number: number;
  branch: string;
  base?: string;
}

export interface PrSuggestion {
  branch: string;
  title: string;
  body: string;
  base: string;
  bases?: string[];
}

export type PrStepName = "checkout" | "commit" | "push" | "create";

export interface PrJobStep {
  name: PrStepName;
  state: "pending" | "running" | "done" | "failed";
  detail?: string;
  progress?: number;
}

export interface PrJob {
  id: string;
  status: "running" | "done" | "failed";
  steps: PrJobStep[];
  error?: string;
  failedStep?: PrStepName;
  pr?: { url: string; number: number; branch: string };
  base: string;
  branch: string;
  startedAt: string;
}

export interface PrStatusResponse {
  pr?: PrRef;
  eligible: boolean;
  reason?: string;
  suggested?: PrSuggestion;
  job?: PrJob;
}

export const PR_POLL_MS = 1000;

const STEP_LOOK: Record<PrJobStep["state"], { tone: Tone; glyph: Glyph }> = {
  done: { tone: "ok", glyph: "dot" },
  running: { tone: "live", glyph: "pulse" },
  pending: { tone: "mute", glyph: "dashed" },
  failed: { tone: "bad", glyph: "diamond" },
};

/** The steps of a Create PR job: glyph, name and mono detail per step. */
export function PrSteps({ job }: { job: PrJob }) {
  return (
    <ol className="pr-steps" aria-label="Progress" data-testid="pr-steps">
      {job.steps.map((s) => {
        const look = STEP_LOOK[s.state];
        return (
          <li key={s.name} className={`pr-step state-${s.state}`} data-testid={`pr-step-${s.name}`} data-state={s.state}>
            <StatusGlyph tone={look.tone} glyph={look.glyph} />
            <span className="pr-step-name">{s.name}</span>
            <span className="pr-step-detail mono" title={s.detail}>
              {s.detail ?? ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

interface Form {
  branch: string;
  base: string;
  title: string;
  body: string;
}

const formOf = (s: PrSuggestion | undefined, job?: PrJob): Form => ({
  branch: job?.branch ?? s?.branch ?? "",
  base: job?.base ?? s?.base ?? "",
  title: s?.title ?? "",
  body: typeof s?.body === "string" ? s.body : "",
});

/** The Create PR/MR flow of an applied run, the PR it already has, or why it can't get one. */
export function PrSection({ ws, runId, status, fullPath }: { ws: string; runId: string; status: string | undefined; fullPath?: string }) {
  const [info, setInfo] = useState<PrStatusResponse | undefined>(undefined);
  const [form, setForm] = useState<Form | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const location = useLocation();
  const titleRef = useRef<HTMLInputElement>(null);
  /** Job ids seen running here, so only a job that finishes while the page watches it toasts. */
  const watched = useRef(new Set<string>());
  const hashHandled = useRef(false);
  const url = `/api/runs/${encodeURIComponent(ws)}/${encodeURIComponent(runId)}/pr`;
  const mr = ws.startsWith("gitlab~");
  const noun = mr ? "MR" : "PR";

  const accept = useCallback(
    (r: PrStatusResponse) => {
      setInfo(r);
      const job = r.job;
      if (job?.status === "running") watched.current.add(job.id);
      if (job?.status === "done" && job.pr && watched.current.has(job.id)) {
        watched.current.delete(job.id);
        const pr = job.pr;
        toast.show({
          tone: "ok",
          text: mr ? `Opened MR !${pr.number}` : `Opened PR #${pr.number}`,
          action: { label: "Open", onClick: () => window.open(pr.url, "_blank", "noopener") },
        });
      }
      setForm((f) => f ?? (r.suggested || job?.status === "running" ? formOf(r.suggested, job?.status === "running" ? job : undefined) : undefined));
    },
    [mr, toast],
  );

  useEffect(() => {
    if (status === undefined) return;
    let cancelled = false;
    api<PrStatusResponse>(url)
      .then((r) => {
        if (!cancelled && typeof r?.eligible === "boolean") accept(r);
      })
      .catch(() => {
        if (!cancelled) setInfo(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [url, status, accept]);

  const running = info?.job?.status === "running";
  const jobId = info?.job?.id;
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api<PrStatusResponse>(url)
        .then((r) => {
          if (!cancelled && typeof r?.eligible === "boolean") accept(r);
        })
        .catch(() => {
          // keep the last answer; the next render polls again
          if (!cancelled) setInfo((i) => (i ? { ...i } : i));
        });
    }, PR_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [running, jobId, info, url, accept]);

  // `#pr`: scroll the panel into view and focus the Title field, once the panel has its content.
  useEffect(() => {
    if (location.hash !== "#pr" || hashHandled.current || !info) return;
    hashHandled.current = true;
    document.getElementById("pr")?.scrollIntoView?.({ block: "start" });
    titleRef.current?.focus();
  }, [location.hash, info, form]);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setError("");
    try {
      const res = await post<{ job: PrJob }>(url, form);
      if (res?.job) {
        watched.current.add(res.job.id);
        setInfo((i) => ({ ...(i ?? { eligible: true }), job: res.job }));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.error : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!info) return <p className="muted pr-note">Checking…</p>;
  const job = info.job;

  if (info.pr) {
    const base = info.pr.base ?? (job?.pr?.number === info.pr.number ? job.base : undefined);
    return (
      <div className="pr-exists" data-testid="pr-exists">
        <a href={info.pr.url} target="_blank" rel="noreferrer" data-testid="pr-link" className="pr-link">
          {mr ? `Merge request !${info.pr.number}` : `Pull request #${info.pr.number}`} ↗
        </a>
        <span className="mono pr-branch">
          {info.pr.branch}
          {base ? ` → ${base}` : ""}
        </span>
      </div>
    );
  }

  const failedJob = job?.status === "failed" ? job : undefined;
  const jobBox = job && job.status !== "done" && (
    <>
      <PrSteps job={job} />
      {failedJob?.error && (
        <pre className="field-error pr-error" data-testid="pr-job-error">
          {failedJob.error}
        </pre>
      )}
    </>
  );

  if (!running && (!info.eligible || !form)) {
    const landed = info.reason?.startsWith("the run has not landed");
    return (
      <div className="pr-unavailable">
        <p className="pr-reason" data-testid="pr-reason">
          <Icon name="info" size={16} />
          <span>Not available: {info.reason ?? "no pull request can be created"}.</span>
        </p>
        {landed && fullPath && (
          <p className="muted pr-note" data-testid="pr-fix-hint">
            Fix it from a terminal in <span className="mono">{fullPath}</span> and start a new run. Create {noun} shows up here once a run lands.
          </p>
        )}
        {jobBox}
      </div>
    );
  }

  const f = form ?? formOf(info.suggested, job);
  const locked = running || busy;
  const set = (patch: Partial<Form>) => setForm((cur) => ({ ...(cur ?? f), ...patch }));
  const bases = Array.from(new Set([f.base, ...(info.suggested?.bases ?? []), ...(info.suggested ? [info.suggested.base] : [])].filter((b) => b !== "")));

  return (
    <form className="pr-form" onSubmit={(e) => void submit(e)} data-testid="pr-form">
      <div className="pr-form-row">
        <label className="field">
          <span className="field-label">Branch</span>
          <input
            className="input mono"
            value={f.branch}
            onChange={(e) => set({ branch: e.target.value })}
            readOnly={locked}
            required
            data-testid="pr-branch"
          />
        </label>
        <label className="field">
          <span className="field-label">Base</span>
          <select className="select mono" value={f.base} onChange={(e) => set({ base: e.target.value })} disabled={locked} data-testid="pr-base">
            {bases.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span className="field-label">Title</span>
        <span className="field-hint">from the spec’s heading</span>
        <input
          ref={titleRef}
          className="input"
          value={f.title}
          onChange={(e) => set({ title: e.target.value })}
          readOnly={locked}
          required
          data-testid="pr-title"
        />
      </label>
      <label className="field">
        <span className="field-label">Body</span>
        <textarea
          className="textarea mono pr-body"
          value={f.body}
          onChange={(e) => set({ body: e.target.value })}
          readOnly={locked}
          rows={8}
          data-testid="pr-body"
        />
      </label>
      {jobBox}
      {error && (
        <pre className="field-error pr-error" data-testid="pr-error">
          {error}
        </pre>
      )}
      <div className="pr-actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            setError("");
            setForm(formOf(info.suggested));
          }}
          disabled={locked}
          data-testid="pr-cancel"
        >
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={locked || !info.eligible} data-testid="pr-submit">
          {locked ? "Creating…" : `Create ${noun}`}
        </button>
      </div>
    </form>
  );
}

export interface ProjectPrJobRepo {
  name: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  steps: PrJobStep[];
  error?: string;
  pr?: { url: string; number: number; branch: string };
}

export interface ProjectPrJob {
  id: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  repos: ProjectPrJobRepo[];
  link: { state: "pending" | "running" | "done" | "failed"; detail?: string };
  error?: string;
}

export interface ProjectPrRepo {
  name: string;
  workspaceId?: string;
  fullPath?: string;
  changed: boolean;
  pr?: PrRef;
  linked?: boolean;
  error?: string;
}

/** `GET …/pr` of a project run (`:ws = project~<id>`): one PR per changed repo (MR-09). */
export interface ProjectPrStatusResponse {
  project: true;
  eligible: boolean;
  reason?: string;
  repos: ProjectPrRepo[];
  job?: ProjectPrJob;
}

type ForgeName = "github" | "gitlab";
const forgeOfId = (id: string | undefined): ForgeName | undefined => {
  const f = id?.split("~")[0];
  return f === "github" || f === "gitlab" ? f : undefined;
};

const REPO_STATE_LABEL: Record<ProjectPrJobRepo["status"], string> = {
  pending: "waiting",
  running: "creating…",
  done: "opened",
  failed: "failed",
  skipped: "no changes",
};

/** The Create PR flow of an applied project run: one row per repo with its PR, its progress or its error. */
export function ProjectPrSection({
  ws,
  runId,
  status,
  onForge,
}: {
  ws: string;
  runId: string;
  status: string | undefined;
  onForge?: (forge: ForgeName | undefined) => void;
}) {
  const [info, setInfo] = useState<ProjectPrStatusResponse | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const watched = useRef(new Set<string>());
  const url = `/api/runs/${encodeURIComponent(ws)}/${encodeURIComponent(runId)}/pr`;
  const forge = forgeOfId(info?.repos.find((r) => r.workspaceId)?.workspaceId);
  const noun = forge === "gitlab" ? "MR" : "PR";

  useEffect(() => {
    onForge?.(forge);
  }, [forge, onForge]);

  const accept = useCallback(
    (r: ProjectPrStatusResponse) => {
      setInfo(r);
      const job = r.job;
      if (job?.status === "running") watched.current.add(job.id);
      if (job && job.status !== "running" && watched.current.has(job.id)) {
        watched.current.delete(job.id);
        const opened = job.repos.filter((x) => x.status === "done").length;
        toast.show(job.status === "done" ? { tone: "ok", text: `Opened ${opened} ${opened === 1 ? "pull request" : "pull requests"}` } : { tone: "bad", text: "Create PRs failed" });
      }
    },
    [toast],
  );

  useEffect(() => {
    if (status === undefined) return;
    let cancelled = false;
    api<ProjectPrStatusResponse>(url)
      .then((r) => {
        if (!cancelled && Array.isArray(r?.repos)) accept(r);
      })
      .catch(() => {
        if (!cancelled) setInfo(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [url, status, accept]);

  const running = info?.job?.status === "running";
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api<ProjectPrStatusResponse>(url)
        .then((r) => {
          if (!cancelled && Array.isArray(r?.repos)) accept(r);
        })
        .catch(() => {
          if (!cancelled) setInfo((i) => (i ? { ...i } : i));
        });
    }, PR_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [running, info, url, accept]);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const res = await post<{ job: ProjectPrJob }>(url, {});
      if (res?.job) {
        watched.current.add(res.job.id);
        setInfo((i) => (i ? { ...i, job: res.job } : i));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.error : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!info) return <p className="muted pr-note">Checking…</p>;
  const job = info.job;
  const failed = job?.status === "failed";

  return (
    <div className="pr-project" data-testid="pr-project">
      <table className="pr-project-repos" data-testid="pr-project-repos">
        <thead>
          <tr>
            <th scope="col">Repo</th>
            <th scope="col">{noun}</th>
          </tr>
        </thead>
        <tbody>
          {info.repos.map((r) => {
            const jr = job?.repos.find((x) => x.name === r.name);
            const err = r.error ?? jr?.error;
            const pr = r.pr ?? jr?.pr;
            return (
              <tr key={r.name} data-testid={`pr-repo-${r.name}`}>
                <td className="mono pr-project-repo">{r.fullPath ?? r.name}</td>
                <td className="pr-project-state">
                  {pr ? (
                    <a href={pr.url} target="_blank" rel="noreferrer" className="pr-link" data-testid={`pr-repo-link-${r.name}`}>
                      {forge === "gitlab" ? `MR !${pr.number}` : `PR #${pr.number}`} ↗
                    </a>
                  ) : jr && running && jr.status === "running" ? (
                    <PrSteps job={{ id: job!.id, status: "running", steps: jr.steps, base: "", branch: "", startedAt: job!.startedAt }} />
                  ) : (
                    <span className="muted" data-testid={`pr-repo-state-${r.name}`}>
                      {jr && (running || jr.status === "failed") ? REPO_STATE_LABEL[jr.status] : r.changed ? "ready" : "no changes"}
                    </span>
                  )}
                  {err && !pr && (
                    <pre className="field-error pr-error" data-testid={`pr-repo-error-${r.name}`}>
                      {err}
                    </pre>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {job?.link.state === "failed" && (
        <pre className="field-error pr-error" data-testid="pr-link-error">
          Linking the {noun}s failed: {job.link.detail}
        </pre>
      )}
      {!info.eligible && !running && info.reason && (
        <p className="pr-reason" data-testid="pr-reason">
          <Icon name="info" size={16} />
          <span>{info.reason === "all pull requests are open" ? `All ${noun}s are open.` : `Not available: ${info.reason}.`}</span>
        </p>
      )}
      {error && (
        <pre className="field-error pr-error" data-testid="pr-error">
          {error}
        </pre>
      )}
      {(info.eligible || running) && (
        <div className="pr-actions">
          <button type="button" className="btn btn-primary" disabled={busy || running || !info.eligible} onClick={() => void submit()} data-testid="pr-submit">
            {busy || running ? "Creating…" : failed ? "Retry" : `Create ${noun}s`}
          </button>
        </div>
      )}
    </div>
  );
}

/** The right-column card of the run detail; `project` for a project run (one PR per repo). */
export function PrPanel({
  ws,
  runId,
  status,
  fullPath,
  project,
}: {
  ws: string;
  runId: string;
  status: string | undefined;
  fullPath?: string;
  project?: boolean;
}) {
  const [projectForge, setProjectForge] = useState<ForgeName | undefined>(undefined);
  const forge = project ? projectForge : forgeOfId(ws);
  return (
    <section id="pr" data-testid="pr-panel" className="pr-panel" aria-label={project ? "Pull requests" : "Pull request"}>
      <div className="pr-panel-head">
        <h2>{project ? "Pull requests" : "Pull request"}</h2>
        {forge && <ForgeChip forge={forge} />}
      </div>
      <div className="pr-panel-body" data-testid="run-pr">
        {project ? (
          <ProjectPrSection ws={ws} runId={runId} status={status} onForge={setProjectForge} />
        ) : (
          <PrSection ws={ws} runId={runId} status={status} {...(fullPath !== undefined ? { fullPath } : {})} />
        )}
      </div>
    </section>
  );
}
