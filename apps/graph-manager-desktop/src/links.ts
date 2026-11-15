export type LinkAction = "same-window" | "new-window" | "external" | "deny" | "switch-server";

/** The token the app adds to its windows' user agent, so graph-manager's web UI knows it runs in the desktop app. */
export function desktopUserAgent(base: string, version: string): string {
  return `${base} graph-manager-desktop/${version}`;
}

/** Where a URL the page opens or navigates to should go, given the app server's origin (`http://127.0.0.1:1234`). */
export function classifyLink(url: string, appOrigin: string, kind: "open" | "navigate"): LinkAction {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "deny";
  }
  // The login page's Switch server button (apps/graph-manager/src/web/pages/Login.tsx) asks for the picker this way.
  if (parsed.protocol === "gm-desktop:") return parsed.pathname === "switch-server" ? "switch-server" : "deny";
  if (parsed.href === "about:blank") return kind === "navigate" ? "same-window" : "deny";
  const web = parsed.protocol === "http:" || parsed.protocol === "https:";
  if (web && parsed.origin === appOrigin) return kind === "open" ? "new-window" : "same-window";
  if (web || parsed.protocol === "mailto:") return "external";
  return "deny";
}
