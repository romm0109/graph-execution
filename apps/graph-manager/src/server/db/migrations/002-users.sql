-- Built-in accounts (docs/prd/hosted-sessions.md): one row per user, and one-time set-password links (invite/reset).
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  -- NULL until a set-password link is used; NULL for gateway users.
  password_hash TEXT,
  -- ISO 8601
  created_at TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE password_links (
  -- sha256 hex of the token; the token itself is never stored.
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
