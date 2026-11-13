'use strict';
// SQLite storage using Node's built-in driver (Node 22.5+), so there are no native modules to build.
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  finished INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL COLLATE NOCASE,
  city TEXT NOT NULL,
  cash INTEGER NOT NULL DEFAULT 0,
  bank INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  turns_at INTEGER NOT NULL,
  protected_until INTEGER NOT NULL DEFAULT 0,
  family_id INTEGER,
  kills INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  card_dealer INTEGER NOT NULL DEFAULT 0,
  bootlegger INTEGER NOT NULL DEFAULT 0,
  hustler INTEGER NOT NULL DEFAULT 0,
  punk INTEGER NOT NULL DEFAULT 0,
  hitman INTEGER NOT NULL DEFAULT 0,
  thug INTEGER NOT NULL DEFAULT 0,
  bodyguard INTEGER NOT NULL DEFAULT 0,
  glock INTEGER NOT NULL DEFAULT 0,
  shotgun INTEGER NOT NULL DEFAULT 0,
  uzi INTEGER NOT NULL DEFAULT 0,
  ak47 INTEGER NOT NULL DEFAULT 0,
  alcohol INTEGER NOT NULL DEFAULT 0,
  weed INTEGER NOT NULL DEFAULT 0,
  coke INTEGER NOT NULL DEFAULT 0,
  sedan INTEGER NOT NULL DEFAULT 0,
  limo INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (round_id, user_id),
  UNIQUE (round_id, name)
);

CREATE TABLE IF NOT EXISTS families (
  id INTEGER PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  name TEXT NOT NULL COLLATE NOCASE,
  boss_id INTEGER NOT NULL,
  city TEXT NOT NULL,
  kills INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (round_id, name)
);

CREATE TABLE IF NOT EXISTS family_requests (
  player_id INTEGER NOT NULL,
  family_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, family_id)
);

CREATE TABLE IF NOT EXISTS family_posts (
  id INTEGER PRIMARY KEY,
  family_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  player_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_player ON events(player_id, id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_to ON messages(to_id, id);

CREATE TABLE IF NOT EXISTS attacks (
  id INTEGER PRIMARY KEY,
  attacker_id INTEGER NOT NULL,
  defender_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  won INTEGER NOT NULL,
  nw_taken INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attacks_defender ON attacks(defender_id, created_at);

CREATE TABLE IF NOT EXISTS round_results (
  round_id INTEGER NOT NULL,
  place INTEGER NOT NULL,
  name TEXT NOT NULL,
  family TEXT,
  networth INTEGER NOT NULL,
  kills INTEGER NOT NULL,
  PRIMARY KEY (round_id, place)
);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);

  const cache = new Map();
  const prep = (sql) => {
    let st = cache.get(sql);
    if (!st) { st = db.prepare(sql); cache.set(sql, st); }
    return st;
  };

  return {
    raw: db,
    get: (sql, ...args) => prep(sql).get(...args),
    all: (sql, ...args) => prep(sql).all(...args),
    run: (sql, ...args) => prep(sql).run(...args),
    // Runs fn inside a transaction; the whole request's game changes commit or roll back together.
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

module.exports = { openDb };
