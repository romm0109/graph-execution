// Remote mode's pure logic: parsing the server URL the user types and checking that a graph-manager answers there.

export type UrlCheck = { ok: true; origin: string; insecure: boolean } | { ok: false; error: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Parses a typed server URL into its origin; `insecure` for plain http to a host other than localhost/127.0.0.1/::1. */
export function normalizeServerUrl(input: string): UrlCheck {
  let text = input.trim();
  if (!text) return { ok: false, error: "That isn't a valid address." };
  if (!text.includes("://")) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "That isn't a valid address." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Use an http:// or https:// address." };
  }
  if (!url.hostname) return { ok: false, error: "That isn't a valid address." };
  return { ok: true, origin: url.origin, insecure: url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname) };
}

/** Whether the origin's host is this machine: 127.0.0.1, localhost or [::1]. */
export function isLoopback(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** Whether `<origin>/api/auth/info` answers 200 with JSON `{ host: string }` within the timeout. */
export async function probeServer(
  origin: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10000,
): Promise<{ ok: true; host: string } | { ok: false; error: string }> {
  const error = `No graph-manager server answered at ${origin}.`;
  try {
    const res = await fetchImpl(`${origin}/api/auth/info`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return { ok: false, error };
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return { ok: false, error };
    const host = (body as { host?: unknown }).host;
    if (typeof host !== "string") return { ok: false, error };
    return { ok: true, host };
  } catch {
    return { ok: false, error };
  }
}
