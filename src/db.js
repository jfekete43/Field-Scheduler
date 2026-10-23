'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'scheduler.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS locations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  address     TEXT NOT NULL DEFAULT '',
  maps_query  TEXT NOT NULL DEFAULT '',
  latitude    REAL,
  longitude   REAL,
  notes       TEXT NOT NULL DEFAULT '',
  map_image   TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fields (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'baseball',
  notes       TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (location_id, slug)
);

CREATE TABLE IF NOT EXISTS field_map_pins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  field_id    INTEGER REFERENCES fields(id) ON DELETE SET NULL,
  label       TEXT NOT NULL,
  x_pct       REAL NOT NULL,
  y_pct       REAL NOT NULL,
  color       TEXT NOT NULL DEFAULT '#1d4ed8'
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'admin',
  active        INTEGER NOT NULL DEFAULT 1,
  must_change   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  field_id    INTEGER NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL DEFAULT 'game',
  title       TEXT NOT NULL DEFAULT '',
  division    TEXT NOT NULL DEFAULT '',
  home_team   TEXT NOT NULL DEFAULT '',
  away_team   TEXT NOT NULL DEFAULT '',
  event_date  TEXT NOT NULL,
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  notes       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'scheduled',
  all_day     INTEGER NOT NULL DEFAULT 0,
  series_id   TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_date  ON events (event_date);
CREATE INDEX IF NOT EXISTS idx_events_field ON events (field_id, event_date);
CREATE INDEX IF NOT EXISTS idx_events_series ON events (series_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username   TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL DEFAULT '',
  entity_id  TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC);
`);

/* Migrations for databases created before a column existed. */
const eventColumns = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
if (!eventColumns.includes('all_day')) {
  db.exec('ALTER TABLE events ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0');
}

const DEFAULT_SETTINGS = {
  league_name: 'Jackson Holbrook Little League',
  league_short: 'JHLL',
  timezone: 'America/New_York',
  logo_path: '',
  announcement: '',
  announcement_level: 'info',
  contact_email: '',
  season_label: '',
};

const insertSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
);
for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  insertSetting.run(key, value);
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const row of rows) out[row.key] = row.value;
  return out;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value ?? ''));
}

function logAction(user, action, entity, entityId, detail) {
  db.prepare(
    `INSERT INTO audit_log (user_id, username, action, entity, entity_id, detail)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    user?.id ?? null,
    user?.username ?? 'system',
    action,
    entity ?? '',
    entityId == null ? '' : String(entityId),
    detail ?? ''
  );
}

module.exports = { db, getSettings, setSetting, logAction, DATA_DIR, UPLOAD_DIR, DEFAULT_SETTINGS };
