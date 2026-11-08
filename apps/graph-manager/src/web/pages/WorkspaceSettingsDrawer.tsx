import { useEffect, useState, type FormEvent } from "react";
import { api, post } from "../api";
import type { SandboxStatus, WorkspaceEntry, WorkspaceSettings } from "../types";
import { Drawer } from "../ui/Drawer";
import { useToast } from "../ui/toast";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const settingsUrl = (id: string) => `/api/workspaces/${encodeURIComponent(id)}/settings`;

/** Workspaces → Settings (KAN-88): the workspace's sandbox image. Open while `workspace` is set. */
export function WorkspaceSettingsDrawer({ workspace, onClose }: { workspace?: WorkspaceEntry; onClose: () => void }) {
  const toast = useToast();
  const [image, setImage] = useState("");
  const [defaultImage, setDefaultImage] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = workspace?.id;

  useEffect(() => {
    if (id === undefined) return;
    let alive = true;
    setImage("");
    setError(null);
    setLoaded(false);
    api<WorkspaceSettings>(settingsUrl(id)).then(
      (s) => {
        if (!alive) return;
        setImage(s?.image ?? "");
        setLoaded(true);
      },
      (err: unknown) => {
        if (!alive) return;
        setError(`Couldn't load the settings: ${message(err)}`);
        setLoaded(true);
      },
    );
    api<SandboxStatus>("/api/sandbox/status").then(
      (s) => alive && setDefaultImage(s?.defaultImage || undefined),
      () => alive && setDefaultImage(undefined),
    );
    return () => {
      alive = false;
    };
  }, [id]);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!workspace || busy) return;
    setBusy(true);
    setError(null);
    try {
      const trimmed = image.trim();
      await post<WorkspaceSettings>(settingsUrl(workspace.id), { image: trimmed === "" ? null : trimmed }, "PUT");
      toast.show({ tone: "ok", text: `Saved settings for ${workspace.fullPath}` });
      onClose();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={workspace !== undefined}
      title={
        <span className="ws-settings-title">
          Workspace settings
          <span className="mono ws-settings-path field-hint">{workspace?.fullPath}</span>
        </span>
      }
      onClose={onClose}
      testId="workspace-settings-drawer"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" data-testid="workspace-settings-save" disabled={!loaded || busy} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <form className="ws-settings-form" onSubmit={(e) => void save(e)}>
        <label className="field">
          <span className="field-label">Sandbox image</span>
          <input
            className="input mono"
            data-testid="workspace-image"
            autoComplete="off"
            spellCheck={false}
            placeholder={defaultImage ?? "graph-manager's image"}
            disabled={!loaded}
            aria-invalid={error ? true : undefined}
            value={image}
            onChange={(e) => setImage(e.target.value)}
          />
          <span className="field-hint">Needs node 20+, git and glibc (not Alpine). Empty: the image built in Settings → Sandbox.</span>
        </label>
        {error && (
          <p className="field-error mono" role="alert" data-testid="workspace-settings-error">
            {error}
          </p>
        )}
      </form>
    </Drawer>
  );
}
