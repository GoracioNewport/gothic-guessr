/**
 * SQLite schema, applied as ordered migrations keyed by `PRAGMA user_version` (SPEC §10.2). Append new migrations at
 * the end; never edit an applied one. All times are epoch ms (INTEGER), booleans 0/1, JSON in TEXT columns.
 *
 * Tables (for the admin agent's stats/moderation queries):
 *   players        id, token_hash (SHA-256 of the device token), nickname, banned, created_at, last_seen_at
 *   bans           history of ban/unban actions (player_id, action 'ban'|'unban', reason, at)
 *   challenges     code, kind ('solo'|'daily'|'party'|'duel'), seed (secret), settings (JSON PublicSettings), rounds,
 *                  picks (JSON [{world,key}]), created_by → players, created_at, date (daily, unique), room_code,
 *                  status ('open'|'running')
 *   games          id, challenge_code → challenges, player_id → players, kind ('solo'|'daily'|'challenge'|'party'|'duel'),
 *                  room_code, created_at, finished_at (NULL while running), total, time_ms, hidden (admin);
 *                  UNIQUE(challenge_code, player_id) = one attempt per player and challenge
 *   rounds         (game_id, n) → games, world, node_key (the answer), started_at, deadline, finished_at, guess_world/x/z,
 *                  distance_m, score, time_ms, timed_out, seen (JSON keys, reach check), current_key
 *   daily_overrides date, settings (JSON), updated_at
 *   hits           at, day (UTC YYYY-MM-DD), path, referrer_host, visitor, lang, admin — no IPs
 *   blocklist      word, added_at
 *   audit_log      at, action, target, details
 *   rooms_log      code, type, host_id, created_at, closed_at (live rooms are in memory; this is for stats)
 *   reports        player problem reports: type, status ('open'|'resolved'|'ignored'), text, categories (JSON), the
 *                  reporter, the resolved panorama of a location report (private) and the client context (no IPs)
 *
 * "Games in progress" = games.finished_at IS NULL with a round started recently; "daily participants" = games of
 * kind 'daily' grouped by challenges.date; "new players" = players.created_at per day.
 */

export const MIGRATIONS: readonly string[] = [
  // 1: initial schema
  `
  CREATE TABLE players (
    id            TEXT PRIMARY KEY,
    token_hash    TEXT NOT NULL UNIQUE,
    nickname      TEXT NOT NULL,
    banned        INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
  );
  CREATE INDEX players_created_at ON players(created_at);
  CREATE INDEX players_nickname ON players(nickname COLLATE NOCASE);

  CREATE TABLE bans (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    action     TEXT NOT NULL CHECK (action IN ('ban', 'unban')),
    reason     TEXT,
    at         INTEGER NOT NULL
  );
  CREATE INDEX bans_player ON bans(player_id, at);

  CREATE TABLE challenges (
    code        TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('solo', 'daily', 'party', 'duel')),
    seed        INTEGER NOT NULL,
    settings    TEXT NOT NULL,
    rounds      INTEGER NOT NULL,
    picks       TEXT NOT NULL,
    created_by  TEXT REFERENCES players(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL,
    date        TEXT UNIQUE,
    room_code   TEXT,
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'running'))
  );
  CREATE INDEX challenges_kind_created ON challenges(kind, created_at);

  CREATE TABLE games (
    id              TEXT PRIMARY KEY,
    challenge_code  TEXT NOT NULL REFERENCES challenges(code) ON DELETE CASCADE,
    player_id       TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('solo', 'daily', 'challenge', 'party', 'duel')),
    room_code       TEXT,
    created_at      INTEGER NOT NULL,
    finished_at     INTEGER,
    total           INTEGER NOT NULL DEFAULT 0,
    time_ms         INTEGER NOT NULL DEFAULT 0,
    hidden          INTEGER NOT NULL DEFAULT 0,
    UNIQUE (challenge_code, player_id)
  );
  CREATE INDEX games_board ON games(challenge_code, finished_at, total DESC, time_ms);
  CREATE INDEX games_player ON games(player_id, created_at);
  CREATE INDEX games_created ON games(created_at, kind);
  CREATE INDEX games_finished ON games(finished_at, kind);

  CREATE TABLE rounds (
    game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    n            INTEGER NOT NULL,
    world        TEXT NOT NULL,
    node_key     TEXT NOT NULL,
    started_at   INTEGER NOT NULL,
    deadline     INTEGER,
    finished_at  INTEGER,
    guess_world  TEXT,
    guess_x      REAL,
    guess_z      REAL,
    distance_m   REAL,
    score        INTEGER NOT NULL DEFAULT 0,
    time_ms      INTEGER NOT NULL DEFAULT 0,
    timed_out    INTEGER NOT NULL DEFAULT 0,
    seen         TEXT NOT NULL,
    current_key  TEXT NOT NULL,
    PRIMARY KEY (game_id, n)
  ) WITHOUT ROWID;
  CREATE INDEX rounds_started ON rounds(started_at);

  CREATE TABLE daily_overrides (
    date        TEXT PRIMARY KEY,
    settings    TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE hits (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    at             INTEGER NOT NULL,
    day            TEXT NOT NULL,
    path           TEXT NOT NULL,
    referrer_host  TEXT NOT NULL DEFAULT '',
    visitor        TEXT NOT NULL,
    lang           TEXT,
    admin          INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX hits_day ON hits(day, admin);
  CREATE INDEX hits_day_visitor ON hits(day, visitor);

  CREATE TABLE blocklist (
    word      TEXT PRIMARY KEY,
    added_at  INTEGER NOT NULL
  );

  CREATE TABLE audit_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    at       INTEGER NOT NULL,
    action   TEXT NOT NULL,
    target   TEXT NOT NULL,
    details  TEXT
  );
  CREATE INDEX audit_at ON audit_log(at);

  CREATE TABLE rooms_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('party', 'duel')),
    host_id     TEXT,
    created_at  INTEGER NOT NULL,
    closed_at   INTEGER
  );
  CREATE INDEX rooms_log_created ON rooms_log(created_at);
  CREATE INDEX rooms_log_code ON rooms_log(code, created_at);
  `,
  // 2: problem reports (server/db/reports.ts). Location columns are private (waypoint, coordinates): admin only.
  `
  CREATE TABLE reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           INTEGER NOT NULL,
    type         TEXT NOT NULL CHECK (type IN ('location', 'translation', 'bug', 'other')),
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
    status_at    INTEGER,
    categories   TEXT NOT NULL DEFAULT '[]',
    text         TEXT NOT NULL DEFAULT '',
    player_id    TEXT REFERENCES players(id) ON DELETE SET NULL,
    nickname     TEXT,
    flagged      INTEGER NOT NULL DEFAULT 0,
    game_id      TEXT,
    round_n      INTEGER,
    world        TEXT,
    node_key     TEXT,
    node_id      INTEGER,
    waypoint     TEXT,
    x            REAL,
    y            REAL,
    z            REAL,
    start_key    TEXT,
    lang         TEXT,
    path         TEXT,
    user_agent   TEXT,
    viewport     TEXT,
    app_version  TEXT
  );
  CREATE INDEX reports_status_at ON reports(status, at);
  CREATE INDEX reports_type_at ON reports(type, at);
  CREATE INDEX reports_world_at ON reports(world, at);
  `,
  // 3: the default nickname changed from `Wanderer0427` to the hero's title (`Nameless Hero 0427`); players who never
  // renamed themselves follow. Their language is unknown here, so they get the English title.
  `
  UPDATE players SET nickname = 'Nameless Hero ' || substr(nickname, 9)
   WHERE nickname GLOB 'Wanderer[0-9][0-9][0-9][0-9]';
  `,
];

/** Schema version after all migrations. */
export const SCHEMA_VERSION = MIGRATIONS.length;
