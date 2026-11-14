// Agent logins (docs/prd/hosted-sessions.md, "Agent logins"): each user logs in to a coding agent once. The agents'
// login files are saved from a session's host when the session ends and written into the next session's host; API
// keys saved in Settings → Agents are added to the env of the user's terminals and runs, and win over saved files.
import type { User } from "../identity.js";
import { LOGIN_FILES, LOGIN_KEYS } from "../sandbox-run.js";
import type { Store } from "../store.js";
import type { SessionManager } from "./sessions.js";

/** The providers whose login files are saved and restored. */
export const LOGIN_PROVIDERS = Object.keys(LOGIN_FILES).filter((p) => p !== "fake");

/** At most this much of one login file (decoded) is saved. */
export const MAX_LOGIN_FILE = 256 * 1024;
/** At most this much of all login files (decoded) is saved per session end. */
export const MAX_LOGIN_TOTAL = 2 * 1024 * 1024;

/** Every distinct variable name in `LOGIN_KEYS` (first-seen order) with the providers that use it. */
export function agentKeyNames(): Array<{ name: string; providers: string[] }> {
  const out = new Map<string, string[]>();
  for (const [provider, names] of Object.entries(LOGIN_KEYS)) {
    for (const name of names) {
      const list = out.get(name) ?? [];
      list.push(provider);
      out.set(name, list);
    }
  }
  return [...out].map(([name, providers]) => ({ name, providers }));
}

export const isAgentKeyName = (name: string): boolean => agentKeyNames().some((k) => k.name === name);

/** The user's saved agent keys: non-empty values of known names only. */
export async function agentKeyEnv(store: Store, user: User): Promise<Record<string, string>> {
  const saved = (await store.forUser(user)).get().agentKeys;
  const out: Record<string, string> = {};
  for (const { name } of agentKeyNames()) {
    const v = saved[name];
    if (typeof v === "string" && v !== "") out[name] = v;
  }
  return out;
}

/** The provider whose `LOGIN_FILES` entry is `rel`, or a folder entry (trailing `/`) that `rel` is inside. */
export function providerOf(rel: string): string | undefined {
  if (rel === "" || rel.split("/").some((c) => c === ".." || c === ".")) return undefined;
  for (const [provider, entries] of Object.entries(LOGIN_FILES)) {
    for (const e of entries) {
      if (e.endsWith("/") ? rel.startsWith(e) && rel.length > e.length : rel === e) return provider;
    }
  }
  return undefined;
}

const decodedSize = (b64: string): number => Buffer.from(b64, "base64").length;

/** Adds the login hooks (save on session end, restore on session start, keys in terminals) to `sessions`. */
export function registerLoginHooks(sessions: SessionManager, store: Store, log: (msg: string) => void = (m) => console.error(m)): void {
  sessions.addHooks({
    afterPrepare: async ({ user, host }) => {
      const d = (await store.forUser(user)).get();
      const keyed = new Set(LOGIN_PROVIDERS.filter((p) => (LOGIN_KEYS[p] ?? []).some((k) => (d.agentKeys[k] ?? "") !== "")));
      const files: Record<string, string> = {};
      const providers = new Set<string>();
      for (const [rel, b64] of Object.entries(d.agentLogins)) {
        const p = providerOf(rel);
        if (p === undefined || keyed.has(p)) continue;
        files[rel] = b64;
        providers.add(p);
      }
      if (Object.keys(files).length > 0) await host.loginFiles("put", [...providers], files);
    },
    beforeRelease: async ({ user, host }) => {
      const got = await host.loginFiles("get", LOGIN_PROVIDERS);
      const keep: Record<string, string> = {};
      let total = 0;
      for (const [rel, b64] of Object.entries(got)) {
        if (providerOf(rel) === undefined) continue;
        const size = decodedSize(b64);
        if (size > MAX_LOGIN_FILE) {
          log(`agent logins of ${user.id}: ${rel} is larger than ${MAX_LOGIN_FILE} bytes, not saved`);
          continue;
        }
        if (total + size > MAX_LOGIN_TOTAL) {
          log(`agent logins of ${user.id}: more than ${MAX_LOGIN_TOTAL} bytes in all, ${rel} not saved`);
          continue;
        }
        total += size;
        keep[rel] = b64;
      }
      if (Object.keys(keep).length === 0) return;
      await (await store.forUser(user)).update((data) => {
        data.agentLogins = { ...data.agentLogins, ...keep };
      });
    },
    terminalEnv: (user) => agentKeyEnv(store, user),
  });
}
