export type LinkAction = "same-window" | "new-window" | "external" | "deny";

/** Where a URL the page opens or navigates to should go, given the app server's origin (`http://127.0.0.1:1234`). */
export function classifyLink(url: string, appOrigin: string, kind: "open" | "navigate"): LinkAction {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "deny";
  }
  if (parsed.href === "about:blank") return kind === "navigate" ? "same-window" : "deny";
  const web = parsed.protocol === "http:" || parsed.protocol === "https:";
  if (web && parsed.origin === appOrigin) return kind === "open" ? "new-window" : "same-window";
  if (web || parsed.protocol === "mailto:") return "external";
  return "deny";
}
