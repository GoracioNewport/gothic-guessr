/**
 * Admin read queries and moderation writes over the SQLite database (schema: server/db/schema.ts). Game logic keeps
 * using the core Repository; these are the admin-only views (statistics, moderation leaderboards, player search,
 * audit paging) plus the few writes the core repository does not have (hide/delete a game).
 *
 * Days are UTC dates; ranges are inclusive (`from`..`to`). Admin page views (hits.admin = 1) never count.
 */
import type {
  AdminAuditEntry,
  AdminBlockedWord,
  AdminLeaderboardEntry,
  AdminPlayer,
  AdminPlayerGame,
  AdminStats,
  AdminStatsDay,
  GameKind,
} from '../../shared/api';
import type { Db } from '../db/database';

export const GAME_KINDS: readonly GameKind[] = ['solo', 'daily', 'challenge', 'party', 'duel'];

/** A game with an open round started within this window counts as "in progress" on the dashboard. */
export const IN_PROGRESS_WINDOW_MS = 30 * 60_000;

const DAY_MS = 86_400_000;
const TOP_N = 10;

/** `date` shifted by `days` (UTC, YYYY-MM-DD). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive list of dates from..to. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const emptyKinds = (): Record<GameKind, number> => ({ solo: 0, daily: 0, challenge: 0, party: 0, duel: 0 });

/** SQL expression: UTC day of an epoch-ms column. */
const dayOf = (col: string): string => `strftime('%Y-%m-%d', ${col} / 1000, 'unixepoch')`;

interface BoardRow {
  id: string;
  player_id: string;
  nickname: string;
  total: number;
  time_ms: number;
  finished_at: number;
  hidden: number;
  banned: number;
}

interface PlayerRow {
  id: string;
  nickname: string;
  banned: number;
  created_at: number;
  last_seen_at: number;
  games: number;
}

export class AdminStore {
  constructor(readonly db: Db) {}

  // Statistics ------------------------------------------------------------------------------------------------------

  /** Dashboard statistics for `from`..`to` (inclusive). `live` is filled by the caller (rooms registry). */
  stats(from: string, to: string, now: number): Omit<AdminStats, 'live'> & { gamesInProgress: number } {
    const days = new Map<string, AdminStatsDay>();
    for (const date of dateRange(from, to)) {
      days.set(date, {
        date,
        pageViews: 0,
        visitors: 0,
        newPlayers: 0,
        gamesStarted: emptyKinds(),
        gamesFinished: emptyKinds(),
        roomsCreated: 0,
        dailyPlayers: 0,
      });
    }
    const fromMs = Date.parse(`${from}T00:00:00Z`);
    const toMs = Date.parse(`${to}T00:00:00Z`) + DAY_MS;
    const db = this.db;

    for (const r of db
      .prepare<[string, string], { day: string; pv: number; v: number }>(
        `SELECT day, COUNT(*) AS pv, COUNT(DISTINCT visitor) AS v FROM hits
         WHERE admin = 0 AND day BETWEEN ? AND ? GROUP BY day`,
      )
      .all(from, to)) {
      const d = days.get(r.day);
      if (d) {
        d.pageViews = r.pv;
        d.visitors = r.v;
      }
    }
    for (const r of db
      .prepare<[number, number], { day: string; n: number }>(
        `SELECT ${dayOf('created_at')} AS day, COUNT(*) AS n FROM players
         WHERE created_at >= ? AND created_at < ? GROUP BY day`,
      )
      .all(fromMs, toMs)) {
      const d = days.get(r.day);
      if (d) d.newPlayers = r.n;
    }
    for (const [col, field] of [
      ['created_at', 'gamesStarted'],
      ['finished_at', 'gamesFinished'],
    ] as const) {
      for (const r of db
        .prepare<[number, number], { day: string; kind: GameKind; n: number }>(
          `SELECT ${dayOf(col)} AS day, kind, COUNT(*) AS n FROM games
           WHERE ${col} >= ? AND ${col} < ? GROUP BY day, kind`,
        )
        .all(fromMs, toMs)) {
        const d = days.get(r.day);
        if (d && r.kind in d[field]) d[field][r.kind] = r.n;
      }
    }
    for (const r of db
      .prepare<[number, number], { day: string; n: number }>(
        `SELECT ${dayOf('created_at')} AS day, COUNT(*) AS n FROM rooms_log
         WHERE created_at >= ? AND created_at < ? GROUP BY day`,
      )
      .all(fromMs, toMs)) {
      const d = days.get(r.day);
      if (d) d.roomsCreated = r.n;
    }
    for (const r of db
      .prepare<[string, string], { day: string; n: number }>(
        `SELECT c.date AS day, COUNT(*) AS n FROM games g JOIN challenges c ON c.code = g.challenge_code
         WHERE c.kind = 'daily' AND c.date BETWEEN ? AND ? GROUP BY c.date`,
      )
      .all(from, to)) {
      const d = days.get(r.day);
      if (d) d.dailyPlayers = r.n;
    }

    const list = [...days.values()];
    const totals: Omit<AdminStatsDay, 'date'> = {
      pageViews: 0,
      // Distinct over the whole range, not the sum of daily uniques.
      visitors:
        db
          .prepare<[string, string], { n: number }>(
            `SELECT COUNT(DISTINCT visitor) AS n FROM hits WHERE admin = 0 AND day BETWEEN ? AND ?`,
          )
          .get(from, to)?.n ?? 0,
      newPlayers: 0,
      gamesStarted: emptyKinds(),
      gamesFinished: emptyKinds(),
      roomsCreated: 0,
      dailyPlayers: 0,
    };
    for (const d of list) {
      totals.pageViews += d.pageViews;
      totals.newPlayers += d.newPlayers;
      totals.roomsCreated += d.roomsCreated;
      totals.dailyPlayers += d.dailyPlayers;
      for (const k of GAME_KINDS) {
        totals.gamesStarted[k] += d.gamesStarted[k];
        totals.gamesFinished[k] += d.gamesFinished[k];
      }
    }

    const topReferrers = db
      .prepare<[string, string, number], { host: string; count: number }>(
        `SELECT referrer_host AS host, COUNT(*) AS count FROM hits
         WHERE admin = 0 AND referrer_host <> '' AND day BETWEEN ? AND ?
         GROUP BY referrer_host ORDER BY count DESC, host LIMIT ?`,
      )
      .all(from, to, TOP_N);
    const topPaths = db
      .prepare<[string, string, number], { path: string; count: number }>(
        `SELECT path, COUNT(*) AS count FROM hits WHERE admin = 0 AND day BETWEEN ? AND ?
         GROUP BY path ORDER BY count DESC, path LIMIT ?`,
      )
      .all(from, to, TOP_N);

    return { from, to, days: list, totals, topReferrers, topPaths, gamesInProgress: this.gamesInProgress(now) };
  }

  /** Unfinished games with an open round started within {@link IN_PROGRESS_WINDOW_MS}. */
  gamesInProgress(now: number): number {
    return (
      this.db
        .prepare<[number], { n: number }>(
          `SELECT COUNT(DISTINCT r.game_id) AS n FROM rounds r JOIN games g ON g.id = r.game_id
           WHERE r.started_at >= ? AND r.finished_at IS NULL AND g.finished_at IS NULL`,
        )
        .get(now - IN_PROGRESS_WINDOW_MS)?.n ?? 0
    );
  }

  // Leaderboard moderation ------------------------------------------------------------------------------------------

  /**
   * Every finished game of a challenge in leaderboard order, hidden games and banned players included; `rank` is the
   * public rank (visible rows only), 0 for invisible rows.
   */
  moderationBoard(code: string, limit = 500): AdminLeaderboardEntry[] {
    const rows = this.db
      .prepare<[string, number], BoardRow>(
        `SELECT g.id, g.player_id, p.nickname, g.total, g.time_ms, g.finished_at, g.hidden, p.banned
         FROM games g JOIN players p ON p.id = g.player_id
         WHERE g.challenge_code = ? AND g.finished_at IS NOT NULL
         ORDER BY g.total DESC, g.time_ms ASC, g.finished_at ASC, g.id ASC LIMIT ?`,
      )
      .all(code, limit);
    const scores = this.roundScores(rows.map((r) => r.id));
    let rank = 0;
    return rows.map((r) => {
      const visible = r.hidden === 0 && r.banned === 0;
      return {
        rank: visible ? ++rank : 0,
        playerId: r.player_id,
        nickname: r.nickname,
        total: r.total,
        timeMs: r.time_ms,
        rounds: scores.get(r.id) ?? [],
        me: false,
        gameId: r.id,
        hidden: r.hidden === 1,
        banned: r.banned === 1,
        finishedAt: r.finished_at,
      };
    });
  }

  private roundScores(gameIds: string[]): Map<string, number[]> {
    const out = new Map<string, number[]>();
    if (gameIds.length === 0) return out;
    const rows = this.db
      .prepare<[string], { game_id: string; score: number }>(
        `SELECT game_id, score FROM rounds WHERE game_id IN (SELECT value FROM json_each(?)) AND finished_at IS NOT NULL
         ORDER BY game_id, n`,
      )
      .all(JSON.stringify(gameIds));
    for (const r of rows) {
      let list = out.get(r.game_id);
      if (!list) out.set(r.game_id, (list = []));
      list.push(r.score);
    }
    return out;
  }

  /** Games of a challenge: all and unfinished. */
  challengeCounts(code: string): { games: number; inProgress: number } {
    const r = this.db
      .prepare<[string], { games: number; open: number | null }>(
        `SELECT COUNT(*) AS games, SUM(finished_at IS NULL) AS open FROM games WHERE challenge_code = ?`,
      )
      .get(code);
    return { games: r?.games ?? 0, inProgress: r?.open ?? 0 };
  }

  /** Per daily date in range: all games, visible finished games and the best visible total. */
  dailyCounts(from: string, to: string): Map<string, { games: number; players: number; best: number | null }> {
    const rows = this.db
      .prepare<[string, string], { date: string; games: number; players: number; best: number | null }>(
        `SELECT c.date AS date, COUNT(g.id) AS games,
                COUNT(CASE WHEN g.finished_at IS NOT NULL AND g.hidden = 0 AND p.banned = 0 THEN 1 END) AS players,
                MAX(CASE WHEN g.finished_at IS NOT NULL AND g.hidden = 0 AND p.banned = 0 THEN g.total END) AS best
         FROM challenges c
         LEFT JOIN games g ON g.challenge_code = c.code
         LEFT JOIN players p ON p.id = g.player_id
         WHERE c.kind = 'daily' AND c.date BETWEEN ? AND ?
         GROUP BY c.date`,
      )
      .all(from, to);
    return new Map(rows.map((r) => [r.date, { games: r.games, players: r.players, best: r.best }]));
  }

  getGameRow(id: string): { id: string; challengeCode: string; playerId: string; hidden: boolean } | null {
    const r = this.db
      .prepare<[string], { id: string; challenge_code: string; player_id: string; hidden: number }>(
        `SELECT id, challenge_code, player_id, hidden FROM games WHERE id = ?`,
      )
      .get(id);
    return r ? { id: r.id, challengeCode: r.challenge_code, playerId: r.player_id, hidden: r.hidden === 1 } : null;
  }

  setGameHidden(id: string, hidden: boolean): boolean {
    return this.db.prepare(`UPDATE games SET hidden = ? WHERE id = ?`).run(hidden ? 1 : 0, id).changes === 1;
  }

  /** Delete a game and its rounds. The player may then play that challenge again. */
  deleteGame(id: string): boolean {
    return this.db.prepare(`DELETE FROM games WHERE id = ?`).run(id).changes === 1;
  }

  // Players ---------------------------------------------------------------------------------------------------------

  /** Players whose nickname contains `q` (case-insensitive for ASCII) or whose id starts with `q`; newest first. */
  searchPlayers(q: string, limit: number): { players: AdminPlayer[]; total: number } {
    const term = q.trim();
    const like = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const prefix = `${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const where = term === '' ? '1' : `(p.nickname LIKE @like ESCAPE '\\' OR p.id LIKE @prefix ESCAPE '\\')`;
    const params = { like, prefix, limit };
    const total =
      this.db.prepare<[typeof params], { n: number }>(`SELECT COUNT(*) AS n FROM players p WHERE ${where}`).get(params)?.n ?? 0;
    const rows = this.db
      .prepare<[typeof params], PlayerRow>(
        `SELECT p.id, p.nickname, p.banned, p.created_at, p.last_seen_at,
                (SELECT COUNT(*) FROM games g WHERE g.player_id = p.id) AS games
         FROM players p WHERE ${where}
         ORDER BY p.created_at DESC, p.id LIMIT @limit`,
      )
      .all(params);
    return { players: rows.map(toAdminPlayer), total };
  }

  getAdminPlayer(id: string): AdminPlayer | null {
    const r = this.db
      .prepare<[string], PlayerRow>(
        `SELECT p.id, p.nickname, p.banned, p.created_at, p.last_seen_at,
                (SELECT COUNT(*) FROM games g WHERE g.player_id = p.id) AS games
         FROM players p WHERE p.id = ?`,
      )
      .get(id);
    return r ? toAdminPlayer(r) : null;
  }

  playerGames(id: string, limit = 200): AdminPlayerGame[] {
    return this.db
      .prepare<
        [string, number],
        {
          id: string;
          challenge_code: string;
          kind: GameKind;
          room_code: string | null;
          created_at: number;
          finished_at: number | null;
          total: number;
          time_ms: number;
          hidden: number;
          rounds: number;
        }
      >(
        `SELECT g.id, g.challenge_code, g.kind, g.room_code, g.created_at, g.finished_at, g.total, g.time_ms, g.hidden,
                (SELECT COUNT(*) FROM rounds r WHERE r.game_id = g.id AND r.finished_at IS NOT NULL) AS rounds
         FROM games g WHERE g.player_id = ? ORDER BY g.created_at DESC LIMIT ?`,
      )
      .all(id, limit)
      .map((r) => ({
        id: r.id,
        challengeCode: r.challenge_code,
        kind: r.kind,
        roomCode: r.room_code,
        createdAt: r.created_at,
        finishedAt: r.finished_at,
        total: r.total,
        timeMs: r.time_ms,
        hidden: r.hidden === 1,
        rounds: r.rounds,
      }));
  }

  banHistory(id: string): { action: 'ban' | 'unban'; reason: string | null; at: number }[] {
    return this.db
      .prepare<[string], { action: 'ban' | 'unban'; reason: string | null; at: number }>(
        `SELECT action, reason, at FROM bans WHERE player_id = ? ORDER BY at DESC, id DESC`,
      )
      .all(id);
  }

  // Blocklist and audit ---------------------------------------------------------------------------------------------

  blockedWords(): AdminBlockedWord[] {
    return this.db
      .prepare<[], { word: string; added_at: number }>(`SELECT word, added_at FROM blocklist ORDER BY word`)
      .all()
      .map((r) => ({ word: r.word, addedAt: r.added_at }));
  }

  /** Newest first, keyset-paged by row id: `before` = the `next` of the previous page. */
  auditPage(limit: number, before: number | null): { entries: AdminAuditEntry[]; next: number | null } {
    const rows = this.db
      .prepare<[number, number], { id: number; at: number; action: string; target: string; details: string | null }>(
        `SELECT id, at, action, target, details FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?`,
      )
      .all(before ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const page = rows.slice(0, limit);
    return {
      entries: page.map((r) => {
        const e: AdminAuditEntry = { at: r.at, action: r.action, target: r.target };
        if (r.details !== null) e.details = r.details;
        return e;
      }),
      next: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }
}

function toAdminPlayer(r: PlayerRow): AdminPlayer {
  return {
    id: r.id,
    nickname: r.nickname,
    banned: r.banned === 1,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    games: r.games,
  };
}
