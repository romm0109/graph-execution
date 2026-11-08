import { useEffect, useState, type FormEvent } from "react";
import { ApiError, api, post } from "../api";
import { useKey } from "../keys";
import { useOverview } from "../overview";
import { workspaceLabel } from "../runs";
import type { SandboxBuild, SandboxStatus, WorkspaceEntry, WorkspaceInspection, WorkspaceSettings } from "../types";
import { Drawer, Kbd, Segmented, useToast } from "../ui";
import { emptyForm, formErrors, formOf, optionLines, optionsOf, type RunOptionsBody, type RunOptionsForm } from "../runOptions";
import { RunOptionsFields } from "./RunOptionsFields";

export const PROVIDER_KEY = "gm.provider";
export const PROVIDERS = ["claude", "codex", "opencode", "qwen", "fake"] as const;
export type Provider = (typeof PROVIDERS)[number];
const PROVIDER_OPTIONS = PROVIDERS.map((p) => ({ value: p, label: p === "fake" ? "fake (test)" : p }));
export const DEFAULT_TASKS_DIR = ".agents/tasks";
const INSPECT_DEBOUNCE_MS = 300;
/** How often the sandbox status is re-read while the sandbox image builds. */
export const SANDBOX_STATUS_POLL_MS = 5000;

function lastProvider(): Provider {
  try {
    const v = localStorage.getItem(PROVIDER_KEY);
    return (PROVIDERS as readonly string[]).includes(v ?? "") ? (v as Provider) : "claude";
  } catch {
    return "claude";
  }
}

function saveProvider(p: Provider): void {
  try {
    localStorage.setItem(PROVIDER_KEY, p);
  } catch {
    // storage blocked: the choice just isn't remembered
  }
}

/** The command the server runs, in its real argument order. */
export function commandPreview(tasksDir: string, spec: string, provider: string, options: RunOptionsBody = {}, sandbox = false): string {
  return [
    `graph-execution ${tasksDir || DEFAULT_TASKS_DIR} \\`,
    `  --spec ${spec || "<spec>"} \\`,
    `  --provider ${provider} \\`,
    ...optionLines(options).map((l) => `  ${l} \\`),
    ...(sandbox ? ["  --web \\", "  --sandbox"] : ["  --web"]),
  ].join("\n");
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The server's answer to a failed start: `error`, plus the CLI's `exitCode` and `output` when it ran. */
interface StartError {
  title: string;
  body?: string;
}

function startErrorOf(err: unknown): StartError {
  if (err instanceof ApiError) {
    const b = (err.body && typeof err.body === "object" ? err.body : {}) as { exitCode?: unknown; output?: unknown };
    const output = typeof b.output === "string" && b.output !== "" ? b.output : undefined;
    if (typeof b.exitCode === "number") return { title: `graph-execution exited with code ${b.exitCode}`, body: output ?? err.error };
    return { title: err.error, body: output };
  }
  return { title: err instanceof Error ? err.message : String(err) };
}

/** The Start run drawer: workspace, tasks folder, spec and provider, with live checks of the paths. */
export function StartRunDrawer({
  open,
  onClose,
  workspaces,
  initialWorkspace,
}: {
  open: boolean;
  onClose: () => void;
  workspaces: WorkspaceEntry[];
  initialWorkspace?: string;
}) {
  const { refresh } = useOverview();
  const toast = useToast();
  const [ws, setWs] = useState("");
  const [tasksDir, setTasksDir] = useState(DEFAULT_TASKS_DIR);
  const [spec, setSpec] = useState("");
  const [provider, setProvider] = useState<Provider>(lastProvider);
  const [info, setInfo] = useState<WorkspaceInspection | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StartError | undefined>(undefined);
  const [form, setForm] = useState<RunOptionsForm>(emptyForm);
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus | undefined>(undefined);
  const [wsSettings, setWsSettings] = useState<WorkspaceSettings | undefined>(undefined);
  const [sandbox, setSandbox] = useState(false);
  const [wsBuild, setWsBuild] = useState<SandboxBuild | undefined>(undefined);

  // Each time it opens: the workspace of the page's filter, else the first one.
  useEffect(() => {
    if (!open) return;
    setError(undefined);
    setWs(initialWorkspace ?? "");
  }, [open, initialWorkspace]);

  // An unknown or empty choice (also when the list arrives after opening) falls back to the first workspace.
  useEffect(() => {
    if (!open || workspaces.length === 0 || workspaces.some((w) => w.id === ws)) return;
    // Functional: the open effect's update of this same commit comes first.
    setWs((cur) => (workspaces.some((w) => w.id === cur) ? cur : (workspaces[0]?.id ?? "")));
  }, [open, ws, workspaces]);

  useEffect(() => {
    if (!open || !ws) {
      setInfo(undefined);
      return;
    }
    let gone = false;
    const t = setTimeout(() => {
      const q = new URLSearchParams();
      if (tasksDir) q.set("tasksDir", tasksDir);
      if (spec) q.set("spec", spec);
      const qs = q.toString();
      api<WorkspaceInspection>(`/api/workspaces/${encodeURIComponent(ws)}/inspect${qs ? `?${qs}` : ""}`)
        .then((res) => {
          if (!gone) setInfo(res);
        })
        .catch(() => {
          if (!gone) setInfo(undefined);
        });
    }, INSPECT_DEBOUNCE_MS);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [open, ws, tasksDir, spec]);

  // The workspace's last start (server-side), else the browser's last provider and repo defaults. Only on open / workspace change.
  useEffect(() => {
    if (!open || !ws) return;
    let gone = false;
    const fallback = () => {
      setProvider(lastProvider());
      setTasksDir(DEFAULT_TASKS_DIR);
      setSpec("");
      setForm(emptyForm());
    };
    api<{ provider?: unknown; tasksDir?: unknown; spec?: unknown; options?: unknown }>(`/api/workspaces/${encodeURIComponent(ws)}/run-defaults`)
      .then((res) => {
        if (gone) return;
        if (typeof res.provider === "string" && (PROVIDERS as readonly string[]).includes(res.provider)) {
          setProvider(res.provider as Provider);
          if (typeof res.tasksDir === "string") setTasksDir(res.tasksDir);
          if (typeof res.spec === "string") setSpec(res.spec);
          setForm(formOf(res.options));
        } else fallback();
      })
      .catch(() => {
        if (!gone) fallback();
      });
    return () => {
      gone = true;
    };
  }, [open, ws]);

  // Run in sandbox (KAN-88): is Docker reachable, checked each time the drawer opens.
  useEffect(() => {
    if (!open) return;
    let gone = false;
    setSandboxStatus(undefined);
    api<SandboxStatus>("/api/sandbox/status")
      .then((res) => {
        if (!gone) setSandboxStatus(res);
      })
      .catch(() => {
        if (!gone) setSandboxStatus({ available: false, reason: "Could not read the sandbox status" });
      });
    return () => {
      gone = true;
    };
  }, [open]);

  // While the sandbox image builds, re-check the status every 5 s until it is ready (or the drawer closes).
  const sandboxBuilding = open && sandboxStatus?.building === true;
  useEffect(() => {
    if (!sandboxBuilding) return;
    let gone = false;
    const timer = setInterval(() => {
      api<SandboxStatus>("/api/sandbox/status").then(
        (res) => {
          if (!gone && res && typeof res.available === "boolean") setSandboxStatus(res);
        },
        () => undefined,
      );
    }, SANDBOX_STATUS_POLL_MS);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [sandboxBuilding]);

  // The workspace's image and its saved switch value (the server saves it on every successful start).
  useEffect(() => {
    if (!open || !ws) {
      setWsSettings(undefined);
      setSandbox(false);
      return;
    }
    let gone = false;
    api<WorkspaceSettings>(`/api/workspaces/${encodeURIComponent(ws)}/settings`)
      .then((res) => {
        if (gone) return;
        setWsSettings(res);
        setSandbox(res.sandbox === true);
      })
      .catch(() => {
        if (gone) return;
        setWsSettings({ sandbox: false, source: "global", image: null, recipe: null, dockerfile: null, effectiveImage: "" });
        setSandbox(false);
      });
    return () => {
      gone = true;
    };
  }, [open, ws]);

  // A workspace with its own recipe: read its image build when the drawer opens, and every 5 s while it runs.
  const recipeWs = open && !!ws && wsSettings?.source === "recipe";
  useEffect(() => {
    setWsBuild(undefined);
    if (!recipeWs) return;
    let gone = false;
    api<SandboxBuild>(`/api/workspaces/${encodeURIComponent(ws)}/sandbox/build`).then(
      (res) => {
        if (!gone && res && typeof res.state === "string") setWsBuild(res);
      },
      () => {
        if (!gone) setWsBuild({ state: "idle", log: [] });
      },
    );
    return () => {
      gone = true;
    };
  }, [recipeWs, ws]);

  const wsBuilding = recipeWs && (wsBuild?.state === "queued" || wsBuild?.state === "building");
  useEffect(() => {
    if (!wsBuilding) return;
    let gone = false;
    const timer = setInterval(() => {
      api<SandboxBuild>(`/api/workspaces/${encodeURIComponent(ws)}/sandbox/build`).then(
        (res) => {
          if (!gone && res && typeof res.state === "string") setWsBuild(res);
        },
        () => undefined,
      );
    }, SANDBOX_STATUS_POLL_MS);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [wsBuilding, ws]);

  const errors = formErrors(form);
  const valid = Object.keys(errors).length === 0;
  // A recipe workspace doesn't need the global image: only Docker, the CLIs and its own build.
  const wsBuildReady = wsBuild?.state === "ready" || wsBuild?.state === "idle";
  const sandboxEnabled = recipeWs
    ? wsBuildReady && (sandboxStatus?.available === true || (sandboxStatus?.building === true && sandboxStatus.clisReady === true))
    : sandboxStatus?.available === true;
  const sandboxOn = sandbox && sandboxEnabled;
  const sandboxImage = wsSettings?.effectiveImage || sandboxStatus?.defaultImage || undefined;

  const canSubmit = valid && !busy && ws !== "" && tasksDir.trim() !== "" && spec.trim() !== "";

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(undefined);
    const options = optionsOf(form);
    try {
      const res = await post<{ runId: string }>(`/api/runs/${encodeURIComponent(ws)}`, {
        tasksDir: tasksDir.trim(),
        spec: spec.trim(),
        provider,
        ...(Object.keys(options).length > 0 ? { options } : {}),
        ...(sandboxOn ? { sandbox: true } : {}),
      });
      saveProvider(provider);
      onClose();
      void refresh();
      toast.show({
        tone: "ok",
        text: `Started run ${res.runId}`,
        action: { label: "Open", to: `/runs/${encodeURIComponent(ws)}/${encodeURIComponent(res.runId)}` },
      });
    } catch (err) {
      setError(startErrorOf(err));
    } finally {
      setBusy(false);
    }
  };

  useKey("Ctrl+Enter", (e) => {
    e.preventDefault();
    void submit();
  }, { enabled: open, allowInInput: true });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const tasksInfo = info?.tasksDir;
  const specMissing = spec !== "" && info?.spec?.exists === false;

  return (
    <Drawer
      open={open}
      title="Start run"
      onClose={onClose}
      testId="start-run-drawer"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="start-run-form" className="btn btn-primary" disabled={!canSubmit} data-testid="start-run-submit">
            {busy ? "Starting…" : "Start run"}
            <Kbd>Ctrl ↵</Kbd>
          </button>
        </>
      }
    >
      <form id="start-run-form" className="start-run-form" onSubmit={onSubmit}>
        <label className="field">
          <span className="field-label">Workspace</span>
          <select
            className="select mono"
            value={ws}
            onChange={(e) => setWs(e.target.value)}
            data-autofocus
            data-testid="start-run-workspace"
          >
            {workspaces.length === 0 && <option value="">No workspaces</option>}
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.fullPath || workspaceLabel(w.id)}
              </option>
            ))}
          </select>
          {info && (
            <span className="field-hint" data-testid="start-run-ws-info">
              {info.branch || "no branch"} · {plural(info.changes, "uncommitted file")}
            </span>
          )}
        </label>
        <label className="field">
          <span className="field-label">Tasks folder</span>
          <input
            className="input mono"
            value={tasksDir}
            onChange={(e) => setTasksDir(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={tasksInfo && (!tasksInfo.exists || tasksInfo.taskFiles === 0) ? true : undefined}
            data-testid="start-run-tasks"
          />
          {tasksInfo &&
            (!tasksInfo.exists ? (
              <span className="field-error" data-testid="start-run-tasks-info">
                Not a folder in this workspace
              </span>
            ) : tasksInfo.taskFiles === 0 ? (
              <span className="field-error" data-testid="start-run-tasks-info">
                No task files found
              </span>
            ) : (
              <span className="field-hint" data-testid="start-run-tasks-info">
                {plural(tasksInfo.taskFiles, "task file")} found
              </span>
            ))}
        </label>
        <label className="field">
          <span className="field-label">Spec path</span>
          <input
            className="input mono"
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            placeholder="docs/prd.md"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={specMissing ? true : undefined}
            data-testid="start-run-spec"
          />
          {specMissing ? (
            <span className="field-error" data-testid="start-run-spec-info">
              File not found
            </span>
          ) : (
            <span className="field-hint">Markdown PRD, relative to the workspace root</span>
          )}
        </label>
        {error && (
          <div className="start-run-error" role="alert" data-testid="start-run-error">
            <strong className="start-run-error-title">{error.title}</strong>
            {error.body && <pre className="start-run-error-body">{error.body}</pre>}
          </div>
        )}
        <div className="field">
          <span className="field-label">Provider</span>
          <Segmented options={PROVIDER_OPTIONS} value={provider} onChange={setProvider} ariaLabel="Provider" className="start-run-providers" />
        </div>
        <RunOptionsFields form={form} onChange={setForm} errors={errors} />
        <div className="field start-run-sandbox" data-testid="start-run-sandbox">
          <label className="start-run-sandbox-switch">
            <input
              type="checkbox"
              role="switch"
              checked={sandboxOn}
              disabled={!sandboxEnabled}
              onChange={(e) => setSandbox(e.target.checked)}
              data-testid="start-run-sandbox-toggle"
            />
            <span>Run in sandbox</span>
          </label>
          {sandboxStatus === undefined ? (
            <span className="field-hint" data-testid="start-run-sandbox-reason">
              Checking Docker…
            </span>
          ) : recipeWs && wsBuild === undefined ? (
            <span className="field-hint" data-testid="start-run-sandbox-reason">
              Checking this workspace's sandbox image…
            </span>
          ) : wsBuilding ? (
            <span className="field-hint" data-testid="start-run-sandbox-reason">
              Building this workspace's sandbox image… (workspace settings)
            </span>
          ) : recipeWs && wsBuild?.state === "failed" ? (
            <span className="field-hint" data-testid="start-run-sandbox-reason">
              The workspace's sandbox image build failed (workspace settings)
            </span>
          ) : !sandboxEnabled ? (
            <span className="field-hint" data-testid="start-run-sandbox-reason">
              {sandboxStatus.building ? "Building the sandbox image… (Settings → Sandbox)" : sandboxStatus.reason || "The sandbox is not available"}
            </span>
          ) : sandboxImage ? (
            <span className="field-hint">
              <span className="mono" data-testid="start-run-sandbox-image">
                Image: {sandboxImage}
              </span>{" "}
              · its own container, sees only this workspace
            </span>
          ) : (
            <span className="field-hint" data-testid="start-run-sandbox-image">
              No image: set one in the workspace's settings
            </span>
          )}
        </div>
        <div className="field">
          <span className="field-label start-run-will-run">Will run</span>
          <pre className="start-run-command" data-testid="start-run-command">
            {commandPreview(tasksDir.trim(), spec.trim(), provider, valid ? optionsOf(form) : {}, sandboxOn)}
          </pre>
        </div>
      </form>
    </Drawer>
  );
}
