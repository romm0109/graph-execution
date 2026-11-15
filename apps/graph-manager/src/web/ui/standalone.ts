import { useEffect, useState } from "react";

/** The non-standard event Chrome, Edge and Android fire when the app can be installed. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Opened from the home screen: `display-mode: standalone`, or iOS Safari's `navigator.standalone`. */
export function isStandalone(): boolean {
  const mm = typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)")?.matches === true;
  return mm || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** iPhone, iPod, iPad, or an iPad that says it is a Mac (MacIntel with touch). */
export function isIos(nav: Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints"> = navigator): boolean {
  return /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
}

/** The request the graph-manager desktop app catches (in its window-open handler) to show its server picker. */
export const DESKTOP_SWITCH_SERVER_URL = "gm-desktop:switch-server";

/** Shown in the graph-manager desktop app, which adds `graph-manager-desktop/<version>` to its user agent. */
export function isDesktopApp(ua: string = navigator.userAgent): boolean {
  return /\bgraph-manager-desktop\//.test(ua);
}

/** In standalone mode, a same-origin `target="_blank"` link opens in the same window (there are no tabs). */
export function standaloneLinkHandler(e: MouseEvent): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element | null)?.closest?.('a[target="_blank"]') as HTMLAnchorElement | null | undefined;
  if (!a) return;
  let url: URL;
  try {
    url = new URL(a.href, location.href);
  } catch {
    return;
  }
  if (url.origin !== location.origin) return;
  e.preventDefault();
  location.assign(url.href);
}

export function useStandaloneLinks(): void {
  useEffect(() => {
    if (!isStandalone()) return;
    document.addEventListener("click", standaloneLinkHandler, true);
    return () => document.removeEventListener("click", standaloneLinkHandler, true);
  }, []);
}

/** Registers `/sw.js` only in a production build, on a secure context, where service workers exist. */
export function registerSw(prod: boolean = import.meta.env.PROD): boolean {
  if (!prod || window.isSecureContext !== true || !("serviceWorker" in navigator)) return false;
  void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  return true;
}

let deferred: BeforeInstallPromptEvent | null = null;
const subscribers = new Set<() => void>();
let listening = false;
const notify = () => subscribers.forEach((f) => f());

/** Idempotent: keeps the first `beforeinstallprompt` (preventDefault) and forgets it on `appinstalled`. */
export function listenForInstallPrompt(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

/** Forgets a captured prompt (tests). */
export function resetInstallPrompt(): void {
  deferred = null;
  notify();
}

export type InstallState = "installed" | "insecure" | "prompt" | "ios" | "other";

export function installState(s: { standalone: boolean; secure: boolean; hasPrompt: boolean; ios: boolean }): InstallState {
  if (s.standalone) return "installed";
  if (!s.secure) return "insecure";
  if (s.hasPrompt) return "prompt";
  if (s.ios) return "ios";
  return "other";
}

export function useInstall(): { state: InstallState; install(): Promise<void> } {
  const [, setTick] = useState(0);
  useEffect(() => {
    const f = () => setTick((n) => n + 1);
    subscribers.add(f);
    return () => {
      subscribers.delete(f);
    };
  }, []);
  const state = installState({ standalone: isStandalone(), secure: window.isSecureContext === true, hasPrompt: deferred !== null, ios: isIos() });
  return {
    state,
    async install() {
      const ev = deferred;
      if (!ev) return;
      deferred = null; // a prompt works once
      try {
        await ev.prompt();
        await ev.userChoice;
      } finally {
        notify();
      }
    },
  };
}
