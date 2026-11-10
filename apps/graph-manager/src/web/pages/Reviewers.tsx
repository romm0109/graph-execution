import { useCallback, useEffect, useState } from "react";
import { ApiError, api, post } from "../api";
import { useOnRefresh } from "../overview";
import { blockLabel, providerLabel, typeLabel, type Reviewer, type ReviewersResponse } from "../reviewers";
import { ConfirmDialog, Icon, SkeletonRows, useToast } from "../ui";
import { ReviewerDrawer } from "./ReviewerDrawer";
import "./Reviewers.css";

export const REVIEWERS_NOTE = "Used by every run started from graph-manager. Runs already going keep the reviewers they started with.";

const message = (err: unknown) => (err instanceof ApiError ? err.error : err instanceof Error ? err.message : String(err));

type DrawerState = { mode: "add" } | { mode: "edit"; reviewer: Reviewer };

export default function Reviewers() {
  const toast = useToast();
  const [data, setData] = useState<ReviewersResponse | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [drawer, setDrawer] = useState<DrawerState | undefined>(undefined);
  const [deleting, setDeleting] = useState<Reviewer | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<ReviewersResponse>("/api/reviewers");
      setData(res);
      setLoadError(undefined);
    } catch (err) {
      setLoadError(message(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useOnRefresh(() => void load());

  const replace = (r: Reviewer) => setData((d) => (d ? { ...d, reviewers: d.reviewers.map((x) => (x.id === r.id ? r : x)) } : d));

  const toggle = async (r: Reviewer) => {
    const next = { ...r, enabled: !r.enabled };
    replace(next);
    try {
      await post(`/api/reviewers/${encodeURIComponent(r.id)}`, next, "PUT");
      void load();
    } catch (err) {
      replace(r);
      toast.show({
        tone: "bad",
        text: `Couldn't ${next.enabled ? "enable" : "disable"} ${r.name}: ${message(err)}`,
      });
    }
  };

  const remove = async (r: Reviewer) => {
    setBusy(true);
    try {
      await api(`/api/reviewers/${encodeURIComponent(r.id)}`, {
        method: "DELETE",
      });
      setDeleting(undefined);
      setData((d) => (d ? { ...d, reviewers: d.reviewers.filter((x) => x.id !== r.id) } : d));
      toast.show({ tone: "ok", text: `Deleted ${r.name}` });
      void load();
    } catch (err) {
      setDeleting(undefined);
      toast.show({
        tone: "bad",
        text: `Couldn't delete ${r.name}: ${message(err)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const onSaved = (r: Reviewer, how: "added" | "saved" | "reset") => {
    if (how === "reset") {
      toast.show({ tone: "ok", text: `Reset ${r.name}` });
      setDrawer({ mode: "edit", reviewer: r });
    } else {
      setDrawer(undefined);
      toast.show({
        tone: "ok",
        text: `${how === "added" ? "Added" : "Saved"} ${r.name}`,
      });
    }
    void load();
  };

  const editing = drawer?.mode === "edit" ? drawer.reviewer : undefined;
  const builtinIds = data?.builtinIds ?? ["code", "tester"];

  let body;
  if (!data && loadError) {
    body = (
      <div className="reviewers-load-error" role="alert">
        <span>Couldn't load reviewers: {loadError}</span>
        <button type="button" className="btn btn-sm" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  } else if (!data) {
    body = <SkeletonRows rows={3} />;
  } else if (data.reviewers.length === 0) {
    body = <p className="muted">No reviewers. Runs started from graph-manager run without a review.</p>;
  } else {
    body = (
      <div className="reviewers-list" role="list">
        {data.reviewers.map((r) => (
          <div key={r.id} className={r.enabled ? "reviewer-row" : "reviewer-row disabled"} role="listitem" data-testid={`reviewer-row-${r.id}`}>
            <label className="reviewer-switch">
              <input
                type="checkbox"
                role="switch"
                checked={r.enabled}
                aria-checked={r.enabled}
                aria-label={`Enable ${r.name}`}
                onChange={() => void toggle(r)}
                data-testid={`reviewer-enabled-${r.id}`}
              />
              <span className="reviewer-switch-track" aria-hidden="true" />
            </label>
            <div className="reviewer-name">
              <strong>{r.name}</strong>
              <span className="mono muted">{r.id}</span>
            </div>
            <span className="reviewer-type badge tone-mute">{typeLabel(r)}</span>
            <span className="reviewer-provider mono">{providerLabel(r)}</span>
            <span className="reviewer-block-at">{blockLabel[r.blockAt]}</span>
            <div className="reviewer-actions">
              <button type="button" className="btn btn-sm" data-testid={`reviewer-edit-${r.id}`} onClick={() => setDrawer({ mode: "edit", reviewer: r })}>
                Edit
              </button>
              {r.type !== "tester" && (
                <button type="button" className="btn btn-sm reviewer-delete" data-testid={`reviewer-delete-${r.id}`} onClick={() => setDeleting(r)}>
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <section className="page reviewers-page" data-testid="page-reviewers">
      <header className="reviewers-header">
        <div className="reviewers-header-text">
          <h1>Reviewers</h1>
          <p className="muted" data-testid="reviewers-note">
            {REVIEWERS_NOTE}
          </p>
          {data?.file && <span className="mono muted reviewers-file">{data.file}</span>}
        </div>
        <button type="button" className="btn btn-primary" data-testid="reviewer-add" onClick={() => setDrawer({ mode: "add" })}>
          <Icon name="plus" size={14} />
          Add reviewer
        </button>
      </header>

      {body}

      <ReviewerDrawer
        open={drawer !== undefined}
        reviewer={editing}
        providers={data?.providers ?? []}
        builtin={editing !== undefined && builtinIds.includes(editing.id)}
        onClose={() => setDrawer(undefined)}
        onSaved={onSaved}
      />
      <ConfirmDialog
        open={deleting !== undefined}
        tone="danger"
        title={deleting ? `Delete ${deleting.name}?` : ""}
        body="Runs started from now on won't run this reviewer."
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
