import { useEffect, useState, type FormEvent } from "react";
import { api, post } from "../api";
import type { SandboxLimits, SandboxStatus } from "../types";
import { useToast } from "../ui/toast";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Fields = { cpus: string; memoryMb: string; pids: string };

const toFields = (l: SandboxLimits): Fields => ({ cpus: String(l.cpus), memoryMb: String(l.memoryMb), pids: String(l.pids) });

// No `min` on CPUs: it would be the step base, making 0.5-steps like 2 invalid (the server checks 0.1–256).
const FIELDS: { key: keyof Fields; label: string; step: number; min?: number; testId: string }[] = [
  { key: "cpus", label: "CPUs", step: 0.5, testId: "sandbox-cpus" },
  { key: "memoryMb", label: "Memory (MB)", step: 256, min: 256, testId: "sandbox-memory" },
  { key: "pids", label: "PIDs", step: 64, min: 64, testId: "sandbox-pids" },
];

/** Settings → Sandbox (KAN-88): Docker status, the default image and the container limits. */
export function SandboxCard() {
  const toast = useToast();
  // undefined: loading; null: the status request failed.
  const [status, setStatus] = useState<SandboxStatus | null | undefined>(undefined);
  const [saved, setSaved] = useState<Fields | undefined>();
  const [fields, setFields] = useState<Fields>({ cpus: "", memoryMb: "", pids: "" });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api<SandboxStatus>("/api/sandbox/status").then(
      (s) => alive && setStatus(s && typeof s.available === "boolean" ? s : null),
      () => alive && setStatus(null),
    );
    api<{ limits: SandboxLimits }>("/api/settings/sandbox").then(
      (res) => {
        if (!alive) return;
        if (!res?.limits) {
          setLoadError("Couldn't load the sandbox limits.");
          return;
        }
        const f = toFields(res.limits);
        setSaved(f);
        setFields(f);
      },
      (err: unknown) => alive && setLoadError(`Couldn't load the sandbox limits: ${message(err)}`),
    );
    return () => {
      alive = false;
    };
  }, []);

  const changed = saved !== undefined && FIELDS.some(({ key }) => fields[key] !== saved[key]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !changed) return;
    setBusy(true);
    setError(null);
    try {
      const body = { cpus: Number(fields.cpus), memoryMb: Number(fields.memoryMb), pids: Number(fields.pids) };
      const res = await post<{ limits: SandboxLimits }>("/api/settings/sandbox", body, "PUT");
      const f = toFields(res?.limits ?? body);
      setSaved(f);
      setFields(f);
      toast.show({ tone: "ok", text: "Saved sandbox limits" });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const disabled = saved === undefined;

  return (
    <section className="settings-card sandbox-card" aria-label="Sandbox" data-testid="sandbox-card">
      <div className="settings-card-head">
        <h2>Sandbox</h2>
        {status === undefined ? null : status === null ? (
          <span className="badge tone-mute" data-tone="mute" data-testid="sandbox-status">
            <span className="glyph glyph-ring" aria-hidden="true" />
            unknown
          </span>
        ) : status.available ? (
          <span className="badge tone-ok" data-tone="ok" data-testid="sandbox-status">
            <span className="glyph glyph-dot" aria-hidden="true" />
            available
          </span>
        ) : (
          <span className="badge tone-mute" data-tone="mute" data-testid="sandbox-status">
            <span className="glyph glyph-ring" aria-hidden="true" />
            not available
          </span>
        )}
      </div>
      <div className="sandbox-body">
        {status && !status.available && status.reason && (
          <p className="field-error sandbox-reason mono" data-testid="sandbox-reason">
            {status.reason}
          </p>
        )}
        <p className="sandbox-image">
          <span className="field-label">Default image</span>{" "}
          {status?.defaultImage ? (
            <code className="mono" data-testid="sandbox-default-image">
              {status.defaultImage}
            </code>
          ) : (
            <span className="muted" data-testid="sandbox-default-image">
              none: set <code className="mono">GM_SANDBOX_IMAGE</code> or a workspace image
            </span>
          )}
        </p>
        <form className="forge-form sandbox-form" onSubmit={(e) => void save(e)}>
          <div className="sandbox-fields">
            {FIELDS.map(({ key, label, step, min, testId }) => (
              <label className="field" key={key}>
                <span className="field-label">{label}</span>
                <input
                  className="input mono"
                  type="number"
                  step={step}
                  min={min}
                  data-testid={testId}
                  disabled={disabled || busy}
                  value={fields[key]}
                  onChange={(e) => setFields((f) => ({ ...f, [key]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          {loadError && (
            <p className="field-error forge-error mono" data-testid="sandbox-load-error">
              {loadError}
            </p>
          )}
          {error && (
            <p className="field-error forge-error mono" role="alert" data-testid="sandbox-error">
              {error}
            </p>
          )}
          <div className="sandbox-actions">
            <span className="field-hint">Applies to sandboxed runs started after saving.</span>
            <button type="submit" className="btn btn-primary" data-testid="sandbox-save" disabled={!changed || busy}>
              Save
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
