import { useEffect, useState } from "react";

/** The one narrow breakpoint of the app: below it the nav is a top bar + drawer and Terminals shows one pane. */
export const NARROW = "(max-width: 899.98px)";
/** Phones: tables become cards below it. */
export const PHONE = "(max-width: 599.98px)";
/** A touch screen (phone, tablet): big hit areas, extra terminal keys. Not decided by width. */
export const COARSE = "(pointer: coarse)";

const mql = (query: string) => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : undefined);

/** True while `query` matches; follows `change` events. False when matchMedia is missing (jsdom). */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => mql(query)?.matches ?? false);
  useEffect(() => {
    const mq = mql(query);
    if (!mq) {
      setMatches(false);
      return;
    }
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [query]);
  return matches;
}
