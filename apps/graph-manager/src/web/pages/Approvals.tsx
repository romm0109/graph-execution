import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, post } from "../api";
import { SpecView } from "../components/SpecView";
import { useNow, useOverview } from "../overview";
import { relativeTime } from "../runs";
import type { RunPlan, RunSummary, WorkspaceEntry } from "../types";
import { EmptyState, ForgeChip, RefLinks, SkeletonRows } from "../ui";
import { useTheme } from "../ui/theme";
import { useToast } from "../ui/toast";
import "./Approvals.css";

const enc = encodeURIComponent;
const runBase = (run: RunSummary) => `/api/runs/${enc(run.workspaceId)}/${enc(run.id)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

function WorkspaceCell({ id, ws }: { id: string; ws?: WorkspaceEntry }) {
  const forge = (ws?.forge ?? id.split("~")[0]) === "gitlab" ? "gitlab" : "github";
  const known = ws?.forge === "github" || ws?.forge === "gitlab" || /^(github|gitlab)~/.test(id);
  return (
    <span className="approval-ws">
      {known && <ForgeChip forge={forge} />}
      <strong className="mono">{ws?.fullPath ?? id}</strong>
    </span>
  );
}

/** One run awaiting approval: its plan, Approve, and Request changes with feedback. */
export function ApprovalRow({ run, ws, now }: { run: RunSummary; ws?: WorkspaceEntry; now: number }) {
  const { refresh } = useOverview();
  const toast = useToast();
  const { resolved } = useTheme();
  const [plan, setPlan] = useState<RunPlan | undefined>(undefined);
  const [planError, setPlanError] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [asking, setAsking] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [sendError, setSendError] = useState<string | undefined>(undefined);

  const { workspaceId, id } = run;
  useEffect(() => {
    let alive = true;
    api<RunPlan>(`/api/runs/${enc(workspaceId)}/${enc(id)}/plan`)
      .then((p) => alive && setPlan(p))
      .catch((err: unknown) => alive && setPlanError(messageOf(err)));
    return () => {
      alive = false;
    };
  }, [workspaceId, id]);

  const approve = async () => {
    setBusy(true);
    try {
      await post(`${runBase(run)}/approve`);
      setApproved(true);
      toast.show({ tone: "ok", text: `Approved ${run.id}` });
      void refresh();
    } catch (err) {
      toast.show({ tone: "bad", text: `Couldn't approve: ${messageOf(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (feedback.trim() === "") return;
    setBusy(true);
    setSendError(undefined);
    try {
      await post(`${runBase(run)}/reject`, { feedback });
      toast.show({ tone: "ok", text: "Sent back for re-planning" });
      setAsking(false);
      setFeedback("");
      void refresh();
    } catch (err) {
      setSendError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const taskCount = plan?.tasks.length;
  const rounds = plan?.feedback.length ?? 0;
  const disabled = busy || approved;

  return (
    <article className={approved ? "approval-row approved" : "approval-row"} data-testid={`approval-${run.workspaceId}-${run.id}`}>
      <div className="approval-head">
        <WorkspaceCell id={run.workspaceId} ws={ws} />
        <Link to={`/runs/${enc(run.workspaceId)}/${enc(run.id)}`} className="approval-run mono">
          {run.id}
        </Link>
        <RefLinks refs={plan?.refs ?? run.refs} />
        <span className="approval-spacer" />
        <span className="approval-age" title={run.createdAt}>
          {relativeTime(run.createdAt, now)}
        </span>
      </div>

      <div className="approval-plan">
        {planError !== undefined ? (
          <span className="field-error" role="alert">
            Couldn&apos;t load the plan: {planError}
          </span>
        ) : plan === undefined ? (
          <span className="muted">Loading the plan…</span>
        ) : (
          <>
            <strong className="approval-title">{plan.spec?.title ?? plan.name}</strong>
            <span className="approval-tasks muted" data-testid="approval-task-count">
              {plural(taskCount ?? 0, "task")}
            </span>
            {rounds > 0 && <span className="runs-pill tone-warn">Re-planned {rounds}×</span>}
            {plan.specError && <span className="field-error">{plan.specError}</span>}
          </>
        )}
      </div>

      <div className="approval-actions">
        <button
          type="button"
          className="btn btn-sm"
          aria-expanded={open}
          disabled={!plan?.spec}
          onClick={() => setOpen((o) => !o)}
          data-testid="approval-view-spec"
        >
          {open ? "Hide spec" : "View spec"}
        </button>
        <span className="approval-spacer" />
        {approved ? (
          <span className="approval-status muted" role="status">
            approved, starting…
          </span>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-sm"
              aria-expanded={asking}
              disabled={disabled}
              onClick={() => {
                setAsking((a) => !a);
                setSendError(undefined);
              }}
              data-testid="approval-request-changes"
            >
              Request changes
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={disabled} onClick={() => void approve()} data-testid="approval-approve">
              Approve
            </button>
          </>
        )}
      </div>

      {asking && !approved && (
        <form
          className="approval-feedback"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            aria-label="What should change?"
            placeholder="What should change?"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={4}
            autoFocus
            data-testid="approval-feedback"
          />
          {sendError !== undefined && (
            <span className="field-error" role="alert">
              {sendError}
            </span>
          )}
          <div className="approval-feedback-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setAsking(false);
                setSendError(undefined);
              }}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || feedback.trim() === ""} data-testid="approval-send">
              Send
            </button>
          </div>
        </form>
      )}

      {open && plan?.spec && (
        <div className="approval-detail">
          <SpecView text={plan.spec.text} theme={resolved} />
          {plan.tasks.length > 0 && (
            <ol className="approval-task-list">
              {plan.tasks.map((t) => (
                <li key={t.id}>
                  <span className="mono muted">{t.id}</span> {t.title}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </article>
  );
}

/** Runs the engine planned and stopped at `awaiting-approval`, across all workspaces, oldest first. */
export default function Approvals() {
  const { runs, workspaces, loaded } = useOverview();
  const now = useNow(30_000);
  const waiting = runs
    .filter((r) => r.type === "run" && r.status === "awaiting-approval")
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id));
  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  return (
    <section className="page approvals-page" data-testid="page-approvals">
      <header className="approvals-header">
        <h1>Approvals</h1>
        <p className="muted">Planned runs wait here for your review. Approve a plan to start it, or send it back with what should change.</p>
      </header>
      {!loaded ? (
        <SkeletonRows rows={3} />
      ) : waiting.length === 0 ? (
        <EmptyState title="Nothing waits for approval." body="Runs started with a plan gate stop here after planning." />
      ) : (
        <div className="approvals-list">
          {waiting.map((r) => (
            <ApprovalRow key={`${r.workspaceId}/${r.id}`} run={r} ws={wsById.get(r.workspaceId)} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}
