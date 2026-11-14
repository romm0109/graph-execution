import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "../ui/Icon";

export interface Notice {
  id: string;
  text: string;
  createdAt: string;
}

const isNotice = (n: unknown): n is Notice =>
  typeof n === "object" && n !== null && typeof (n as Notice).id === "string" && typeof (n as Notice).text === "string";

/** The user's notices (e.g. a session closed after being idle), fetched once on mount; the server returns each once. */
export function NoticeBanner() {
  const [notices, setNotices] = useState<Notice[]>([]);

  useEffect(() => {
    let alive = true;
    api<{ notices?: unknown }>("/api/notices")
      .then((res) => {
        const list = res && Array.isArray(res.notices) ? res.notices.filter(isNotice) : [];
        if (alive && list.length > 0) setNotices(list);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (notices.length === 0) return null;
  return (
    <div className="notice-stack">
      {notices.map((n) => (
        <div key={n.id} className="notice-banner" role="status" data-testid="notice-banner">
          <Icon name="info" size={15} className="notice-banner-icon" />
          <span className="notice-banner-text">{n.text}</span>
          <button
            type="button"
            className="nav-icon-btn notice-banner-close"
            aria-label="Dismiss"
            onClick={() => setNotices((all) => all.filter((x) => x.id !== n.id))}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
