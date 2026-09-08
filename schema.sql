-- Millions Boss Hunt — D1 schema
-- Run this once against the D1 database before the event starts.

-- Per-boss KPH setting. Pre-seed this from boss_hunt_config.json's default
-- actualKPH values (NULL where none), then edit anytime from the admin page.
-- Point values for every item at that boss are computed live from this.
CREATE TABLE boss_kph (
  boss_name   TEXT PRIMARY KEY,
  actual_kph  REAL
);

-- Raw drop log. This is the single source of truth — everything the public
-- page shows (points, GE value, bonus completion) is computed from this
-- table plus boss_kph, never stored redundantly.
CREATE TABLE drops (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  boss_name           TEXT NOT NULL,
  item_name           TEXT NOT NULL,
  team                TEXT NOT NULL,
  rsn                 TEXT,
  quantity            INTEGER NOT NULL DEFAULT 1,
  is_collection_log   INTEGER NOT NULL DEFAULT 0,
  logged_at           INTEGER NOT NULL,
  undone              INTEGER NOT NULL DEFAULT 0,
  undone_at           INTEGER
);
CREATE INDEX idx_drops_team ON drops(team);
CREATE INDEX idx_drops_boss ON drops(boss_name);

-- Bounty completions (major/minor, per rotation number).
CREATE TABLE bounty_completions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  bounty_number  INTEGER NOT NULL,
  bounty_type    TEXT NOT NULL,     -- 'Major' or 'Minor'
  team           TEXT NOT NULL,
  placement      TEXT NOT NULL,     -- '1st Place' or '2nd Place'
  logged_at      INTEGER NOT NULL,
  undone         INTEGER NOT NULL DEFAULT 0,
  undone_at      INTEGER
);

-- Manual reveal toggle — a bounty doesn't show on the public page until
-- an admin flips this (per your "manual for now" decision).
CREATE TABLE bounty_reveals (
  bounty_number  INTEGER NOT NULL,
  bounty_type    TEXT NOT NULL,
  revealed       INTEGER NOT NULL DEFAULT 0,
  revealed_at    INTEGER,
  PRIMARY KEY (bounty_number, bounty_type)
);

-- Simple key/value settings store — currently just the prize pool, but flexible
-- for any other admin-editable event-wide setting later without a schema change.
CREATE TABLE event_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);
INSERT INTO event_settings (key, value) VALUES ('prizePool', '0');

-- Per-item manual point-value multiplier (matches the "Manual Adjustment"
-- column in your spreadsheet — normally 0.75 for jars/pets, 1.0 otherwise,
-- but editable per item here if you need to adjust a specific one).
CREATE TABLE item_manual_adjustments (
  boss_name   TEXT NOT NULL,
  item_name   TEXT NOT NULL,
  adjustment  REAL NOT NULL,
  PRIMARY KEY (boss_name, item_name)
);

-- Human-readable audit trail of every admin action, shown on the admin
-- page for accountability. Separate from the raw tables above so it reads
-- like a log even after something's been undone.
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT NOT NULL,     -- 'drop_added' | 'drop_undone' | 'bounty_marked' | 'bounty_undone' | 'kph_updated' | 'bounty_revealed'
  details     TEXT NOT NULL,     -- human-readable summary, e.g. "Logged: Tiny Hawk +1 Araxyte fang (Araxxor)"
  logged_at   INTEGER NOT NULL
);
