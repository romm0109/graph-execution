-- The base tables: instance-wide settings, each user's settings (one JSON document), applied migrations.
CREATE TABLE IF NOT EXISTS instance (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_data (user_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
