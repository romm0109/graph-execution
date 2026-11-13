import type { ReactNode } from "react";

export type IconName =
  | "logo"
  | "runs"
  | "terminal"
  | "folder"
  | "settings"
  | "search"
  | "plus"
  | "close"
  | "external"
  | "moon"
  | "sun"
  | "monitor"
  | "logout"
  | "chevron-left"
  | "chevron-right"
  | "chevron-down"
  | "branch"
  | "maximize"
  | "layout-1"
  | "layout-2"
  | "layout-4"
  | "info"
  | "git"
  | "refresh"
  | "menu"
  | "review"
  | "extension"
  | "check";

// Stroke icons on a 16×16 grid (shapes from 02-component-nav-rail), drawn with currentColor.
const PATHS: Record<Exclude<IconName, "logo">, ReactNode> = {
  check: <path d="m3 8.5 3 3 7-7" />,
  runs: (
    <>
      <rect x="1.5" y="2" width="4.5" height="4" rx="1" />
      <rect x="10" y="2" width="4.5" height="4" rx="1" />
      <rect x="5.75" y="10" width="4.5" height="4" rx="1" />
      <path d="M3.75 6v1.5c0 .8.7 1.5 1.5 1.5H8m4.25-3v1.5c0 .8-.7 1.5-1.5 1.5H8m0 0v1" />
    </>
  ),
  terminal: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="m4.5 6 2 2-2 2M8.5 10.5h3" />
    </>
  ),
  folder: <path d="M1.75 4.25c0-.7.55-1.25 1.25-1.25h3l1.5 1.75H13c.7 0 1.25.55 1.25 1.25v6c0 .7-.55 1.25-1.25 1.25H3c-.7 0-1.25-.55-1.25-1.25z" />,
  settings: (
    <>
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.5 3.5" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  external: <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />,
  moon: <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06" />
    </>
  ),
  monitor: (
    <>
      <rect x="1.5" y="2.5" width="13" height="8.5" rx="1.5" />
      <path d="M5.5 14h5M8 11v3" />
    </>
  ),
  logout: <path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6M10.5 11 13.5 8l-3-3M13.5 8H6" />,
  "chevron-left": <path d="m10 3.5-4.5 4.5 4.5 4.5" />,
  "chevron-right": <path d="m6 3.5 4.5 4.5L6 12.5" />,
  "chevron-down": <path d="m3.5 6 4.5 4.5L12.5 6" />,
  branch: (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5" r="1.5" />
      <path d="M4.5 5v6M11.5 6.5c0 2.5-3 3-7 4.5" />
    </>
  ),
  maximize: <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />,
  menu: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  extension: <path d="M3 4.5h3V3.75a1.25 1.25 0 0 1 2.5 0v.75h3v3h-.75a1.25 1.25 0 0 0 0 2.5h.75v3h-8.75z" />,
  review: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3M5 7l1.5 1.5L9 5.5" />
    </>
  ),
  "layout-1": <rect x="2" y="2.5" width="12" height="11" rx="1.5" />,
  "layout-2": (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M8 2.5v11" />
    </>
  ),
  "layout-4": (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M8 2.5v11M2 8h12" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.5V11M8 5h.01" />
    </>
  ),
  git: (
    <>
      <circle cx="5" cy="4" r="1.5" />
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="11" cy="8" r="1.5" />
      <path d="M5 5.5v5M6.3 4.8 9.7 7.2" />
    </>
  ),
  refresh: <path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.5v3h-3" />,
};

/** An inline SVG icon in `currentColor`. `logo` is the app mark (branching graph on a rounded square). */
export function Icon({ name, size = 16, title, className }: { name: IconName; size?: number; title?: string; className?: string }) {
  const a11y = title ? { role: "img", "aria-label": title } : { "aria-hidden": true as const };
  const cls = className ? `icon ${className}` : "icon";
  if (name === "logo") {
    return (
      <svg className={cls} width={size} height={size} viewBox="0 0 22 22" fill="none" data-icon="logo" {...a11y}>
        <rect x="1" y="1" width="20" height="20" rx="5" fill="var(--fg)" />
        <circle cx="7" cy="7.5" r="2" fill="var(--sf)" />
        <circle cx="15" cy="7.5" r="2" fill="var(--sf)" />
        <circle cx="11" cy="15" r="2" fill="var(--sf)" />
        <path d="M7 9.5 10 13.3M15 9.5 12 13.3" stroke="var(--sf)" strokeWidth="1.4" />
      </svg>
    );
  }
  return (
    <svg
      className={cls}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon={name}
      {...a11y}
    >
      {PATHS[name]}
    </svg>
  );
}
