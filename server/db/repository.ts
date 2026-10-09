/**
 * better-sqlite3 implementation of the core {@link Repository}. Statements are prepared once; every method is
 * synchronous underneath and wrapped in a resolved promise to satisfy the async interface.
 *
 * The admin module may run its own read queries on `repo.db` (schema in ./schema.ts) for statistics; writes that
 * game logic depends on should go through this class or the core services.
 */
import type { ChallengeKind, GameKind, PublicSettings, WorldGuess } from '../../shared/api';
import type {
  AuditRecord,
  ChallengeRecord,
  ChallengeStatus,
  GameRecord,
  HitRecord,
  LeaderboardRow,
  PlayerRecord,
  Repository,
  RoundOutcome,
  RoundPick,
  RoundRecord,
} from '../core/repository';
import type { Db } from './database';

interface PlayerRow {
  id: string;
  token_hash: string;
  nickname: string;
  banned: number;
  created_at: number;
  last_seen_at: number;
}

interface ChallengeRow {
  code: string;
  kind: ChallengeKind;
  seed: number;
  settings: string;
  rounds: number;
  picks: string;
  created_by: string | null;
  created_at: number;
  date: string | null;
  room_code: string | null;
  status: ChallengeStatus;
}

interface GameRow {
  id: string;
  challenge_code: string;
  player_id: string;
  kind: GameKind;
  room_code: string | null;
  created_at: number;
  finished_at: number | null;
  total: number;
  time_ms: number;
  hidden: number;
}

interface RoundRow {
  game_id: string;
  n: number;
  world: string;
  node_key: string;
  started_at: number;
  deadline: number | null;
  finished_at: number | null;
  guess_world: string | null;
  guess_x: number | null;
  guess_z: number | null;
  distance_m: number | null;
  score: number;
  time_ms: number;
  timed_out: number;
  seen: string;
  current_key: string;
}

interface BoardRow {
  id: string;
  player_id: string;
  nickname: string;
  total: number;
  time_ms: number;
  finished_at: number;
}

/** WHERE clause of a visible leaderboard row (games g JOIN players p). */
const VISIBLE = `g.challenge_code = ? AND g.finished_at IS NOT NULL AND g.hidden = 0 AND p.banned = 0`;
/** ORDER BY of core/leaderboard.ts compareLeaderboard. */
const BOARD_ORDER = `g.total DESC, g.time_ms ASC, g.finished_at ASC, g.id ASC`;

export class SqliteRepository implements Repository {
  private readonly s;

  constructor(readonly db: Db) {
    const p = <T = unknown>(sql: string) => db.prepare<unknown[], T>(sql);
    this.s = {
      insertPlayer: p(`INSERT INTO players (id, token_hash, nickname, banned, created_at, last_seen_at)
                       VALUES (@id, @token_hash, @nickname, @banned, @created_at, @last_seen_at)`),
      getPlayer: p<PlayerRow>(`SELECT * FROM players WHERE id = ?`),
      getPlayerByToken: p<PlayerRow>(`SELECT * FROM players WHERE token_hash = ?`),
      updateNickname: p(`UPDATE players SET nickname = ? WHERE id = ?`),
      touchPlayer: p(`UPDATE players SET last_seen_at = ? WHERE id = ?`),
      setBanned: p(`UPDATE players SET banned = ? WHERE id = ?`),
      insertBan: p(`INSERT INTO bans (player_id, action, reason, at) VALUES (?, ?, ?, ?)`),

      insertChallenge: p(`INSERT OR IGNORE INTO challenges
                          (code, kind, seed, settings, rounds, picks, created_by, created_at, date, room_code, status)
                          VALUES (@code, @kind, @seed, @settings, @rounds, @picks, @created_by, @created_at, @date,
                                  @room_code, @status)`),
      getChallenge: p<ChallengeRow>(`SELECT * FROM challenges WHERE code = ?`),
      getDaily: p<ChallengeRow>(`SELECT * FROM challenges WHERE date = ?`),
      listRunning: p<{ code: string }>(`SELECT code FROM challenges WHERE status = 'running' ORDER BY created_at`),
      countBoard: p<{ n: number }>(`SELECT COUNT(*) AS n FROM games g JOIN players p ON p.id = g.player_id WHERE ${VISIBLE}`),
      countGames: p<{ n: number }>(`SELECT COUNT(*) AS n FROM games WHERE challenge_code = ?`),

      insertGame: p(`INSERT OR IGNORE INTO games
                     (id, challenge_code, player_id, kind, room_code, created_at, finished_at, total, time_ms, hidden)
                     VALUES (@id, @challenge_code, @player_id, @kind, @room_code, @created_at, @finished_at, @total,
                             @time_ms, @hidden)`),
      getGame: p<GameRow>(`SELECT * FROM games WHERE id = ?`),
      getGameOf: p<GameRow>(`SELECT * FROM games WHERE challenge_code = ? AND player_id = ?`),
      listGames: p<GameRow>(`SELECT * FROM games WHERE challenge_code = ? ORDER BY created_at, rowid`),
      updateTotals: p(`UPDATE games SET total = ?, time_ms = ? WHERE id = ?`),
      finishGame: p(`UPDATE games SET finished_at = ? WHERE id = ? AND finished_at IS NULL`),

      listRounds: p<RoundRow>(`SELECT * FROM rounds WHERE game_id = ? ORDER BY n`),
      insertRound: p(`INSERT OR IGNORE INTO rounds
                      (game_id, n, world, node_key, started_at, deadline, finished_at, guess_world, guess_x, guess_z,
                       distance_m, score, time_ms, timed_out, seen, current_key)
                      VALUES (@game_id, @n, @world, @node_key, @started_at, @deadline, @finished_at, @guess_world,
                              @guess_x, @guess_z, @distance_m, @score, @time_ms, @timed_out, @seen, @current_key)`),
      updatePosition: p(`UPDATE rounds SET seen = ?, current_key = ? WHERE game_id = ? AND n = ? AND finished_at IS NULL`),
      finishRound: p(`UPDATE rounds SET finished_at = @finished_at, guess_world = @guess_world, guess_x = @guess_x,
                        guess_z = @guess_z, distance_m = @distance_m, score = @score, time_ms = @time_ms,
                        timed_out = @timed_out
                      WHERE game_id = @game_id AND n = @n AND finished_at IS NULL`),
      setDeadline: p(`UPDATE rounds SET deadline = ? WHERE game_id = ? AND n = ? AND finished_at IS NULL`),

      board: p<BoardRow>(`SELECT g.id, g.player_id, p.nickname, g.total, g.time_ms, g.finished_at
                          FROM games g JOIN players p ON p.id = g.player_id
                          WHERE ${VISIBLE} ORDER BY ${BOARD_ORDER} LIMIT ?`),
      boardOne: p<BoardRow>(`SELECT g.id, g.player_id, p.nickname, g.total, g.time_ms, g.finished_at
                             FROM games g JOIN players p ON p.id = g.player_id
                             WHERE ${VISIBLE} AND g.id = ?`),
      boardAbove: p<{ n: number }>(`SELECT COUNT(*) AS n FROM games g JOIN players p ON p.id = g.player_id
                                    WHERE ${VISIBLE} AND (g.total > @total
                                      OR (g.total = @total AND g.time_ms < @time_ms)
                                      OR (g.total = @total AND g.time_ms = @time_ms AND g.finished_at < @finished_at)
                                      OR (g.total = @total AND g.time_ms = @time_ms AND g.finished_at = @finished_at
                                          AND g.id < @id))`),
      roundScores: p<{ game_id: string; n: number; score: number }>(
        `SELECT game_id, n, score FROM rounds WHERE game_id IN (SELECT value FROM json_each(?)) AND finished_at IS NOT NULL
         ORDER BY game_id, n`,
      ),

      getOverride: p<{ settings: string }>(`SELECT settings FROM daily_overrides WHERE date = ?`),
      setOverride: p(`INSERT INTO daily_overrides (date, settings, updated_at) VALUES (?, ?, ?)
                      ON CONFLICT(date) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`),
      deleteOverride: p(`DELETE FROM daily_overrides WHERE date = ?`),

      insertHit: p(`INSERT INTO hits (at, day, path, referrer_host, visitor, lang, admin)
                    VALUES (@at, @day, @path, @referrer_host, @visitor, @lang, @admin)`),

      listBlocked: p<{ word: string }>(`SELECT word FROM blocklist ORDER BY word`),
      addBlocked: p(`INSERT OR IGNORE INTO blocklist (word, added_at) VALUES (?, ?)`),
      removeBlocked: p(`DELETE FROM blocklist WHERE word = ?`),
      addAudit: p(`INSERT INTO audit_log (at, action, target, details) VALUES (?, ?, ?, ?)`),
      listAudit: p<AuditRow>(`SELECT at, action, target, details FROM audit_log WHERE at < ? ORDER BY at DESC, id DESC LIMIT ?`),

      roomCreated: p(`INSERT INTO rooms_log (code, type, host_id, created_at) VALUES (?, ?, ?, ?)`),
      roomClosed: p(`UPDATE rooms_log SET closed_at = ? WHERE id = (
                       SELECT id FROM rooms_log WHERE code = ? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1)`),
    };
  }

  // Players ----------------------------------------------------------------------------------------------------------

  async insertPlayer(p: PlayerRecord): Promise<void> {
    this.s.insertPlayer.run({
      id: p.id,
      token_hash: p.tokenHash,
      nickname: p.nickname,
      banned: p.banned ? 1 : 0,
      created_at: p.createdAt,
      last_seen_at: p.lastSeenAt,
    });
  }

  async getPlayer(id: string): Promise<PlayerRecord | null> {
    return toPlayer(this.s.getPlayer.get(id));
  }

  async getPlayerByTokenHash(tokenHash: string): Promise<PlayerRecord | null> {
    return toPlayer(this.s.getPlayerByToken.get(tokenHash));
  }

  async updateNickname(id: string, nickname: string): Promise<void> {
    this.s.updateNickname.run(nickname, id);
  }

  async touchPlayer(id: string, at: number): Promise<void> {
    this.s.touchPlayer.run(at, id);
  }

  async setBanned(id: string, banned: boolean, at: number, reason?: string): Promise<void> {
    this.db.transaction(() => {
      this.s.setBanned.run(banned ? 1 : 0, id);
      this.s.insertBan.run(id, banned ? 'ban' : 'unban', reason ?? null, at);
    })();
  }

  // Challenges -------------------------------------------------------------------------------------------------------

  async insertChallenge(c: ChallengeRecord): Promise<boolean> {
    const info = this.s.insertChallenge.run({
      code: c.code,
      kind: c.kind,
      seed: c.seed,
      settings: JSON.stringify(c.settings),
      rounds: c.rounds,
      picks: JSON.stringify(c.picks),
      created_by: c.createdBy,
      created_at: c.createdAt,
      date: c.date,
      room_code: c.roomCode,
      status: c.status,
    });
    return info.changes === 1;
  }

  async getChallenge(code: string): Promise<ChallengeRecord | null> {
    return toChallenge(this.s.getChallenge.get(code));
  }

  async getDailyChallenge(date: string): Promise<ChallengeRecord | null> {
    return toChallenge(this.s.getDaily.get(date));
  }

  async updateChallenge(
    code: string,
    patch: Partial<Pick<ChallengeRecord, 'settings' | 'rounds' | 'picks' | 'status'>>,
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.settings !== undefined) set('settings', JSON.stringify(patch.settings));
    if (patch.rounds !== undefined) set('rounds', patch.rounds);
    if (patch.picks !== undefined) set('picks', JSON.stringify(patch.picks));
    if (patch.status !== undefined) set('status', patch.status);
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE challenges SET ${sets.join(', ')} WHERE code = ?`).run(...values, code);
  }

  async countLeaderboard(code: string): Promise<number> {
    return this.s.countBoard.get(code)?.n ?? 0;
  }

  async countGames(code: string): Promise<number> {
    return this.s.countGames.get(code)?.n ?? 0;
  }

  async listRunningChallenges(): Promise<string[]> {
    return this.s.listRunning.all().map((r) => r.code);
  }

  // Games ------------------------------------------------------------------------------------------------------------

  async insertGame(g: GameRecord): Promise<boolean> {
    const info = this.s.insertGame.run({
      id: g.id,
      challenge_code: g.challengeCode,
      player_id: g.playerId,
      kind: g.kind,
      room_code: g.roomCode,
      created_at: g.createdAt,
      finished_at: g.finishedAt,
      total: g.total,
      time_ms: g.timeMs,
      hidden: g.hidden ? 1 : 0,
    });
    return info.changes === 1;
  }

  async getGame(id: string): Promise<GameRecord | null> {
    return toGame(this.s.getGame.get(id));
  }

  async getGameOf(challengeCode: string, playerId: string): Promise<GameRecord | null> {
    return toGame(this.s.getGameOf.get(challengeCode, playerId));
  }

  async listGamesOfChallenge(challengeCode: string): Promise<GameRecord[]> {
    return this.s.listGames.all(challengeCode).map((r) => toGame(r)!);
  }

  async updateGameTotals(id: string, total: number, timeMs: number): Promise<void> {
    this.s.updateTotals.run(total, Math.round(timeMs), id);
  }

  async finishGame(id: string, at: number): Promise<boolean> {
    return this.s.finishGame.run(at, id).changes === 1;
  }

  // Rounds -----------------------------------------------------------------------------------------------------------

  async listRounds(gameId: string): Promise<RoundRecord[]> {
    return this.s.listRounds.all(gameId).map(toRound);
  }

  async insertRound(r: RoundRecord): Promise<boolean> {
    const info = this.s.insertRound.run({
      game_id: r.gameId,
      n: r.n,
      world: r.world,
      node_key: r.key,
      started_at: r.startedAt,
      deadline: r.deadline,
      finished_at: r.finishedAt,
      guess_world: r.guess?.world ?? null,
      guess_x: r.guess?.x ?? null,
      guess_z: r.guess?.z ?? null,
      distance_m: r.distanceM,
      score: r.score,
      time_ms: r.timeMs,
      timed_out: r.timedOut ? 1 : 0,
      seen: JSON.stringify(r.seen),
      current_key: r.currentKey,
    });
    return info.changes === 1;
  }

  async updateRoundPosition(gameId: string, n: number, seen: string[], currentKey: string): Promise<void> {
    this.s.updatePosition.run(JSON.stringify(seen), currentKey, gameId, n);
  }

  async finishRound(gameId: string, n: number, o: RoundOutcome): Promise<boolean> {
    const info = this.s.finishRound.run({
      game_id: gameId,
      n,
      finished_at: o.finishedAt,
      guess_world: o.guess?.world ?? null,
      guess_x: o.guess?.x ?? null,
      guess_z: o.guess?.z ?? null,
      distance_m: o.distanceM,
      score: o.score,
      time_ms: Math.round(o.timeMs),
      timed_out: o.timedOut ? 1 : 0,
    });
    return info.changes === 1;
  }

  async setRoundDeadline(gameId: string, n: number, deadline: number | null): Promise<void> {
    this.s.setDeadline.run(deadline, gameId, n);
  }

  // Leaderboards -----------------------------------------------------------------------------------------------------

  async leaderboard(challengeCode: string, limit: number): Promise<LeaderboardRow[]> {
    const rows = this.s.board.all(challengeCode, limit);
    return this.withRoundScores(rows);
  }

  async leaderboardEntry(challengeCode: string, gameId: string): Promise<(LeaderboardRow & { rank: number }) | null> {
    const row = this.s.boardOne.get(challengeCode, gameId);
    if (!row) return null;
    const above = this.s.boardAbove.get(challengeCode, { ...row, id: row.id })?.n ?? 0;
    const [entry] = this.withRoundScores([row]);
    return { ...entry!, rank: above + 1 };
  }

  private withRoundScores(rows: BoardRow[]): LeaderboardRow[] {
    const scores = new Map<string, number[]>();
    if (rows.length > 0) {
      for (const r of this.s.roundScores.all(JSON.stringify(rows.map((x) => x.id)))) {
        let list = scores.get(r.game_id);
        if (!list) scores.set(r.game_id, (list = []));
        list.push(r.score);
      }
    }
    return rows.map((r) => ({
      gameId: r.id,
      playerId: r.player_id,
      nickname: r.nickname,
      total: r.total,
      timeMs: r.time_ms,
      finishedAt: r.finished_at,
      rounds: scores.get(r.id) ?? [],
    }));
  }

  // Daily overrides --------------------------------------------------------------------------------------------------

  async getDailyOverride(date: string): Promise<PublicSettings | null> {
    const row = this.s.getOverride.get(date);
    return row ? (JSON.parse(row.settings) as PublicSettings) : null;
  }

  async setDailyOverride(date: string, settings: PublicSettings, at: number): Promise<void> {
    this.s.setOverride.run(date, JSON.stringify(settings), at);
  }

  async deleteDailyOverride(date: string): Promise<void> {
    this.s.deleteOverride.run(date);
  }

  // Analytics --------------------------------------------------------------------------------------------------------

  async insertHit(h: HitRecord): Promise<void> {
    this.s.insertHit.run({
      at: h.at,
      day: h.day,
      path: h.path,
      referrer_host: h.referrerHost,
      visitor: h.visitor,
      lang: h.lang,
      admin: h.admin ? 1 : 0,
    });
  }

  // Moderation -------------------------------------------------------------------------------------------------------

  async listBlockedWords(): Promise<string[]> {
    return this.s.listBlocked.all().map((r) => r.word);
  }

  async addBlockedWord(word: string, at: number): Promise<void> {
    this.s.addBlocked.run(word, at);
  }

  async removeBlockedWord(word: string): Promise<void> {
    this.s.removeBlocked.run(word);
  }

  async addAudit(e: AuditRecord): Promise<void> {
    this.s.addAudit.run(e.at, e.action, e.target, e.details ?? null);
  }

  async listAudit(limit: number, beforeAt = Number.MAX_SAFE_INTEGER): Promise<AuditRecord[]> {
    return this.s.listAudit.all(beforeAt, limit).map((r) => {
      const e: AuditRecord = { at: r.at, action: r.action, target: r.target };
      if (r.details !== null) e.details = r.details;
      return e;
    });
  }

  // Rooms ------------------------------------------------------------------------------------------------------------

  async logRoomCreated(code: string, type: 'party' | 'duel', hostId: string, at: number): Promise<void> {
    this.s.roomCreated.run(code, type, hostId, at);
  }

  async logRoomClosed(code: string, at: number): Promise<void> {
    this.s.roomClosed.run(at, code);
  }
}

interface AuditRow {
  at: number;
  action: string;
  target: string;
  details: string | null;
}

function toPlayer(r: PlayerRow | undefined): PlayerRecord | null {
  if (!r) return null;
  return {
    id: r.id,
    tokenHash: r.token_hash,
    nickname: r.nickname,
    banned: r.banned === 1,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}

function toChallenge(r: ChallengeRow | undefined): ChallengeRecord | null {
  if (!r) return null;
  return {
    code: r.code,
    kind: r.kind,
    seed: r.seed,
    settings: JSON.parse(r.settings) as PublicSettings,
    rounds: r.rounds,
    picks: JSON.parse(r.picks) as RoundPick[],
    createdBy: r.created_by,
    createdAt: r.created_at,
    date: r.date,
    roomCode: r.room_code,
    status: r.status,
  };
}

function toGame(r: GameRow | undefined): GameRecord | null {
  if (!r) return null;
  return {
    id: r.id,
    challengeCode: r.challenge_code,
    playerId: r.player_id,
    kind: r.kind,
    roomCode: r.room_code,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    total: r.total,
    timeMs: r.time_ms,
    hidden: r.hidden === 1,
  };
}

function toRound(r: RoundRow): RoundRecord {
  const guess: WorldGuess | null =
    r.guess_world !== null && r.guess_x !== null && r.guess_z !== null ? { world: r.guess_world, x: r.guess_x, z: r.guess_z } : null;
  return {
    gameId: r.game_id,
    n: r.n,
    world: r.world,
    key: r.node_key,
    startedAt: r.started_at,
    deadline: r.deadline,
    finishedAt: r.finished_at,
    guess,
    distanceM: r.distance_m,
    score: r.score,
    timeMs: r.time_ms,
    timedOut: r.timed_out === 1,
    seen: JSON.parse(r.seen) as string[],
    currentKey: r.current_key,
  };
}
