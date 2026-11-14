// Settings → Repositories: the sandbox image and the saved Start run choices of each repository (`GET /api/repositories`).
// Edit opens the repository settings drawer; Forget run defaults deletes the saved Start run choices.

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { WorkspaceEntry, WorkspaceSettings } from "../types";
import { ForgeChip } from "../ui/ForgeChip";
import { SkeletonRows } from "../ui/Skeleton";
import { useToast } from "../ui/toast";
import { WorkspaceSettingsDrawer } from "./WorkspaceSettingsDrawer";

/** One row of `GET /api/repositories` (src/server/routes/sandbox.ts). */
export interface RepositoryRow {
  id: string;
  forge: string;
  fullPath: string;
  settings: WorkspaceSettings;
  runDefaults?: { provider: string; tasksDir: string; spec: string; options?: Record<string, unknown> };
}

/** `Global recipe`, `Own recipe` or `Ready-made image <name>`. */
export function imageSourceText(s: WorkspaceSettings): string {
  if (s.source === "image") return `Ready-made image ${s.image ?? ""}`.trim();
  if (s.source === "recipe") return "Own recipe";
  return "Global recipe";
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function RepositoriesCard() {
  const toast = useToast();
  const [rows, setRows] = useState<RepositoryRow[] | undefined>(undefined);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<WorkspaceEntry | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const res = await api<{ repositories?: RepositoryRow[] }>("/api/repositories");
      setRows(Array.isArray(res?.repositories) ? res.repositories : []);
      setError("");
    } catch (err) {
      setError(message(err));
      setRows((r) => r ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const forget = async (row: RepositoryRow) => {
    if (busy) return;
    setBusy(row.id);
    try {
      await api(`/api/workspaces/${encodeURIComponent(row.id)}/run-defaults`, { method: "DELETE" });
      toast.show({ tone: "ok", text: `Forgot the run defaults of ${row.fullPath}` });
      await load();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section className="settings-card repositories-card" aria-label="Repositories" data-testid="repositories">
      <div className="settings-card-head">
        <div className="repositories-head-text">
          <h2>Repositories</h2>
          <span className="field-hint">Sandbox image and saved Start run choices per repository.</span>
        </div>
      </div>
      <div className="repositories-body">
        {error && (
          <p className="field-error" role="alert" data-testid="repositories-error">
            {error}
          </p>
        )}
        {rows === undefined ? (
          <SkeletonRows rows={2} />
        ) : rows.length === 0 ? (
          <p className="muted repositories-empty" data-testid="repositories-empty">
            No repository has its own settings yet. Open a session and press Edit here, or start a run to save its choices.
          </p>
        ) : (
          <div className="repositories-table-wrap">
            <table className="table repositories-table" role="table">
              <thead>
                <tr>
                  <th scope="col">Repository</th>
                  <th scope="col">Image</th>
                  <th scope="col">Sandbox</th>
                  <th scope="col">Run defaults</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="table-row" data-testid={`repo-row-${r.id}`}>
                    <td>
                      <span className="repositories-repo">
                        {(r.forge === "github" || r.forge === "gitlab") && <ForgeChip forge={r.forge} />}
                        <span className="mono">{r.fullPath}</span>
                      </span>
                    </td>
                    <td className="repositories-image" title={imageSourceText(r.settings)}>
                      {imageSourceText(r.settings)}
                    </td>
                    <td>{r.settings.sandbox ? "on" : "off"}</td>
                    <td className="mono repositories-defaults">{r.runDefaults ? `${r.runDefaults.provider} · ${r.runDefaults.tasksDir}` : "—"}</td>
                    <td className="repositories-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        data-testid={`repo-edit-${r.id}`}
                        onClick={() =>
                          setEditing({ id: r.id, fullPath: r.fullPath, forge: r.forge, path: "", branch: "", dirty: false, remoteUrl: "" })
                        }
                      >
                        Edit
                      </button>
                      {r.runDefaults && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={busy === r.id}
                          data-testid={`repo-forget-${r.id}`}
                          onClick={() => void forget(r)}
                        >
                          Forget run defaults
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <WorkspaceSettingsDrawer
        workspace={editing}
        onClose={() => {
          setEditing(undefined);
          void load();
        }}
      />
    </section>
  );
}
