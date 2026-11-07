import type { ReactNode } from "react";

/** A keyboard shortcut hint, e.g. `<Kbd>Ctrl K</Kbd>`. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
