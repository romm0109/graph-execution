import { useEffect, useState, type FormEvent } from "react";
import { api, post } from "../api";
import { useToast } from "../ui/toast";

interface Account {
  id: string;
  username: string;
  displayName: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Settings → Account: the username, the display name and a password change (which ends the other sign-ins). */
export function AccountCard() {
  const toast = useToast();
  const [account, setAccount] = useState<Account | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<Account>("/api/account")
      .then((a) => {
        if (cancelled) return;
        setAccount(a);
        setName(a.displayName);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(message(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNameError(null);
    try {
      const a = await post<Account>("/api/account", { displayName: name }, "PATCH");
      setAccount(a);
      setName(a.displayName);
      toast.show({ tone: "ok", text: "Saved." });
    } catch (err) {
      setNameError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== repeat) {
      setPwError("Passwords don't match.");
      return;
    }
    setBusy(true);
    setPwError(null);
    try {
      await post<Account>("/api/account", { currentPassword: current, newPassword: next }, "PATCH");
      setCurrent("");
      setNext("");
      setRepeat("");
      toast.show({ tone: "ok", text: "Password changed. Other sign-ins were ended." });
    } catch (err) {
      setPwError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const disabled = account === null || busy;

  return (
    <section className="settings-card" aria-label="Account" data-testid="account">
      <div className="settings-card-head">
        <h2>Account</h2>
        {account && (
          <code className="mono" data-testid="account-username">
            {account.username}
          </code>
        )}
      </div>
      {loadError && (
        <p className="field-error forge-error mono" data-testid="account-load-error">
          {loadError}
        </p>
      )}
      <form className="forge-form" onSubmit={(e) => void saveName(e)}>
        <label className="field">
          <span className="field-label">Display name</span>
          <input className="input" type="text" autoComplete="name" disabled={disabled} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {nameError && (
          <p className="field-error forge-error mono" role="alert" data-testid="account-name-error">
            {nameError}
          </p>
        )}
        <div>
          <button type="submit" className="btn btn-primary" disabled={disabled || name.trim() === "" || name === account.displayName}>
            Save
          </button>
        </div>
      </form>
      <form className="forge-form" onSubmit={(e) => void changePassword(e)}>
        <label className="field">
          <span className="field-label">Current password</span>
          <input className="input" type="password" autoComplete="current-password" disabled={disabled} value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">New password</span>
          <input className="input" type="password" autoComplete="new-password" disabled={disabled} value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Repeat new password</span>
          <input className="input" type="password" autoComplete="new-password" disabled={disabled} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </label>
        {pwError && (
          <p className="field-error forge-error mono" role="alert" data-testid="account-password-error">
            {pwError}
          </p>
        )}
        <div>
          <button type="submit" className="btn btn-primary" disabled={disabled || current === "" || next === ""}>
            Change password
          </button>
        </div>
      </form>
    </section>
  );
}
