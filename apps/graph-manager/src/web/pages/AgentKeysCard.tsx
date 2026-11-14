import { useEffect, useState, type FormEvent } from "react";
import { api, post } from "../api";
import { ConfirmDialog } from "../ui/Dialog";
import { useToast } from "../ui/toast";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One login key as `GET /api/settings/agent-keys` lists it (never its value). */
export interface AgentKey {
  name: string;
  providers: string[];
  saved: boolean;
}

const PROVIDER_LABELS: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", qwen: "Qwen Code" };

export const providersLabel = (providers: string[]): string => `Used by ${providers.map((p) => PROVIDER_LABELS[p] ?? p).join(", ")}`;

const keyUrl = (name: string) => `/api/settings/agent-keys/${encodeURIComponent(name)}`;

/** Settings → Agents (hosted sessions, "Agent logins"): API keys that log the user's agents in. */
export function AgentKeysCard() {
  // undefined: loading.
  const [keys, setKeys] = useState<AgentKey[] | undefined>();
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ keys?: AgentKey[] }>("/api/settings/agent-keys").then(
      (res) => {
        if (!alive) return;
        if (Array.isArray(res?.keys)) setKeys(res.keys);
        else setLoadError("Couldn't load the agent keys.");
      },
      () => alive && setLoadError("Couldn't load the agent keys."),
    );
    return () => {
      alive = false;
    };
  }, []);

  const setSaved = (name: string, saved: boolean) => setKeys((ks) => ks?.map((k) => (k.name === name ? { ...k, saved } : k)));

  return (
    <section className="settings-card" aria-label="Agents" data-testid="agent-keys">
      <header className="settings-card-head">
        <h2>Agents</h2>
      </header>
      <div className="agent-keys-body">
        <p className="field-hint">API keys log agents in without a browser login. Saved for your account only; a key wins over a saved login.</p>
        {loadError ? (
          <p className="forge-error" role="alert" data-testid="agent-keys-error">
            {loadError}
          </p>
        ) : keys === undefined ? null : (
          keys.map((k) => <AgentKeyRow key={k.name} item={k} onSaved={(saved) => setSaved(k.name, saved)} />)
        )}
      </div>
    </section>
  );
}

function AgentKeyRow({ item, onSaved }: { item: AgentKey; onSaved: (saved: boolean) => void }) {
  const toast = useToast();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || value.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await post(keyUrl(item.name), { value }, "PUT");
      setValue("");
      onSaved(true);
      toast.show({ tone: "ok", text: `Saved ${item.name}` });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(keyUrl(item.name), { method: "DELETE" });
      onSaved(false);
      toast.show({ tone: "ok", text: `Removed ${item.name}` });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  return (
    <form className="agent-key" data-testid={`agent-key-${item.name}`} onSubmit={(e) => void save(e)}>
      <div className="agent-key-text">
        <span className="agent-key-name mono">
          {item.name}
          {item.saved && (
            <span className="badge tone-ok" data-tone="ok" data-testid="agent-key-saved">
              <span className="glyph glyph-dot" aria-hidden="true" />
              saved
            </span>
          )}
        </span>
        <span className="forge-meta">{providersLabel(item.providers)}</span>
      </div>
      <div className="agent-key-controls">
        <input
          className="input mono"
          type="password"
          autoComplete="off"
          aria-label={item.name}
          placeholder={item.saved ? "Replace the saved key" : "Paste a key"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || value.trim() === ""}>
          Save
        </button>
        {item.saved && (
          <button type="button" className="btn forge-disconnect" disabled={busy} onClick={() => setConfirm(true)}>
            Remove
          </button>
        )}
      </div>
      {error && (
        <p className="forge-error" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        title={`Remove ${item.name}?`}
        body="New terminals and runs no longer get this key. Terminals already open keep it."
        confirmLabel="Remove"
        tone="danger"
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setConfirm(false)}
      />
    </form>
  );
}
