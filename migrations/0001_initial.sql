-- MAMAX initial schema (اجرای دستی اختیاری؛ پنل در اولین اجرا خودش این جدول‌ها را می‌سازد)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_admin ON sessions(admin_id);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'vless' CHECK (protocol IN ('vless')),
  address TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 443,
  tls INTEGER NOT NULL DEFAULT 1 CHECK (tls IN (0,1)),
  sni TEXT NOT NULL DEFAULT '',
  host_header TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '/ws',
  transport TEXT NOT NULL DEFAULT 'ws' CHECK (transport IN ('ws')),
  fingerprint TEXT NOT NULL DEFAULT 'chrome',
  alpn TEXT NOT NULL DEFAULT 'http/1.1',
  early_data INTEGER NOT NULL DEFAULT 2048,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  uuid TEXT NOT NULL UNIQUE,
  traffic_limit INTEGER NOT NULL DEFAULT 0,
  up_bytes INTEGER NOT NULL DEFAULT 0,
  down_bytes INTEGER NOT NULL DEFAULT 0,
  duration_days INTEGER NOT NULL DEFAULT 0,
  start_on_first_use INTEGER NOT NULL DEFAULT 0 CHECK (start_on_first_use IN (0,1)),
  first_used_at INTEGER,
  expire_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_name ON users(name);

CREATE INDEX IF NOT EXISTS idx_users_enabled ON users(enabled);

CREATE INDEX IF NOT EXISTS idx_users_expire ON users(expire_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_access_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_configs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  config_id INTEGER NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, config_id)
);

CREATE INDEX IF NOT EXISTS idx_user_configs_config ON user_configs(config_id);

CREATE TABLE IF NOT EXISTS traffic_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  up_bytes INTEGER NOT NULL DEFAULT 0,
  down_bytes INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_traffic_day ON traffic_usage(day);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  user_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);
