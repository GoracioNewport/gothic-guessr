/**
 * Game service: ONE engine for solo, daily, challenge and room (party/duel) games (SPEC §10.4, §10.5). Pure logic over
 * the async {@link Repository}, the {@link WorldRegistry} and an injected clock; no `node:*` imports.
 *
 * Model: a *challenge* fixes the settings and the start node of every round (`picks`, drawn once with `pickRounds` of
 * src/game/state.ts from a secret seed); a *game* is one player's attempt at a challenge (one per player and
 * challenge); a *round* row records start time, deadline, the reach-check state and, once over, the outcome.
 * Expired rounds (deadline + {@link DEADLINE_GRACE_MS}) are closed lazily as timeouts whenever the game is touched.
 * Every mutation of a game runs under a per-game mutex, and the repository writes are compare-and-set.
 *
 * ─── Player-facing API (used by server/routes/games.ts, challenges.ts, daily.ts) ──────────────────────────────────────
 *   createSolo(playerId, settings)          → GameView   new challenge (kind solo, random seed) + the caller's game
 *   joinChallenge(playerId, code)           → GameView   resume or create; finished → `already_played`
 *   joinDaily(playerId)                     → GameView   today's daily (UTC)
 *   getGame(gameId, playerId)               → GameView   404 unless the caller owns the game
 *   openRound(gameId, playerId)             → RoundView  idempotent while a round is open; room games → `forbidden`
 *   getNode(gameId, playerId, key)          → PanoNode   reach check: start, seen, or a link of a seen node
 *   guess(gameId, playerId, guess | null)   → RoundResultView   after deadline + 2 s → recorded as timeout. Room
 *                                            games: while round n is still open for another room player the result is
 *                                            `pending` (no answer, distance null, score 0); getGame does the same and
 *                                            leaves pending scores out of `total`. The room's `roundResult` reveals it.
 *   summary(gameId, playerId, origin)       → GameSummaryView   finished games only (`conflict` otherwise)
 *   challengeView(code, playerId | null)    → ChallengeView
 *   leaderboard(code, playerId | null, limit) → LeaderboardView   empty while a room challenge is `running`
 *   dailyView(date | null, playerId | null) → ChallengeView   today (created lazily) or a past day that exists
 *
 * ─── Room API (for server/rooms/: the room registry drives rounds, players move/guess over REST) ──────────────────────
 *   createRoomGames({type, settings, roomCode, hostId, playerIds}) → {challengeCode, games: {playerId: gameId}, rounds}
 *       Creates the room's challenge (kind `party`|`duel`, status `running`: the share link `/c/<code>` refuses to be
 *       played until finishRoomChallenge) and one game per player (kind `party`|`duel`, roomCode set). `settings` are
 *       validated with parseSettings(kind = type): party rounds 3|5|10, duel picks 30 rounds (the cap).
 *   openRoomRound(challengeCode, n, {startedAt, deadline}) → {n, node: PanoNode}
 *       Opens round n of EVERY unfinished game of the challenge with the same start time and deadline (any still-open
 *       earlier round is closed as a timeout first). Push `node`, `deadline` and `startedAt` to the sockets. Duel: pass
 *       the base deadline (time limit or the 5 min hard cap, see DUEL_HARD_CAP_S).
 *   setRoomRoundDeadline(challengeCode, n, deadline) → void
 *       Moves the deadline of every still-open round n (duel: first guess → now + 15 s, never later than before).
 *   closeRoomRound(challengeCode, n) → {n, answer: WorldGuess, results: RoomRoundResult[]}
 *       Ends round n: every game that has not guessed gets a timeout (score 0); returns everyone's outcome (all games
 *       of the challenge, in game creation order). Call it when all connected players guessed or the deadline passed.
 *   finishRoomChallenge(challengeCode, roundsPlayed) → void
 *       Ends the room game: closes open rounds, finishes every game, truncates the challenge to `roundsPlayed` rounds
 *       (duel: rounds actually played) and opens the share link (status `open`).
 *   listChallengeGames(challengeCode) → GameRecord[]  (totals/time for standings)
 *   events.on('guess', e => …)
 *       Fired after every round outcome recorded through the player API: a guess, a give-up (`guess: null`) or a lazy
 *       timeout. `e.roomCode` is set for room games; rooms filter on it. Not fired for closeRoomRound outcomes.
 *   events.on('gameFinished', e => …)  Fired when a game gets its finishedAt.
 *
 * ─── Admin helpers ────────────────────────────────────────────────────────────────────────────────────────────────────
 *   setDailyOverride(date, settings, {force}) → ChallengeView   validates settings, stores the override, and when the
 *       day's challenge exists re-draws its picks (same seed) — refused with `conflict` if it has games and !force.
 *   clearDailyOverride(date, {force})        → same, back to the defaults.
 *   dailySettings(date)                      → {settings, overridden}
 */
import type {
  ChallengeView,
  GameKind,
  GameSummaryView,
  GameView,
  LeaderboardEntry,
  LeaderboardView,
  PanoNode,
  PublicSettings,
  RoomRoundResult,
  RoomType,
  RoundResultView,
  RoundView,
  WorldGuess,
} from '../../shared/api';
import { pickRounds } from '../../src/game/state';
import { scoreForGuess } from '../../src/game/scoring';
import { ApiFailure } from './errors';
import { Emitter } from './events';
import { KeyedMutex } from './mutex';
import { challengeCode as newChallengeCode, dailySeed, randomId, randomSeed } from './random';
import type { ChallengeRecord, GameRecord, LeaderboardRow, Repository, RoundPick, RoundRecord, RoundOutcome } from './repository';
import {
  DEADLINE_GRACE_MS,
  dailyCode,
  defaultDailySettings,
  isIsoDate,
  parseSettings,
  settingsForLoadedWorlds,
  utcDate,
} from './settings';
import { dailyShareText } from './share';
import { requireNodeByKey, requireWorld, nodeByKey, toPanoNode, worldSlugs } from './worlds';
import type { WorldRegistry } from './worlds';

export interface GuessEvent {
  gameId: string;
  playerId: string;
  challengeCode: string;
  kind: GameKind;
  roomCode: string | null;
  n: number;
  result: RoundResultView;
  /** The game finished with this round. */
  gameFinished: boolean;
  at: number;
}

export interface GameFinishedEvent {
  gameId: string;
  playerId: string;
  challengeCode: string;
  kind: GameKind;
  roomCode: string | null;
  total: number;
  at: number;
}

export interface GameEvents {
  guess: GuessEvent;
  gameFinished: GameFinishedEvent;
}

export interface GameServiceDeps {
  repo: Repository;
  worlds: WorldRegistry;
  /** Epoch ms. */
  clock: () => number;
  /** SERVER_SECRET: keys the daily seed. */
  secret: string;
  events?: Emitter<GameEvents>;
}

export interface RoomGamesResult {
  challengeCode: string;
  /** playerId → gameId. */
  games: Record<string, string>;
  /** Picks available: party = settings.rounds, duel = 30. */
  rounds: number;
  settings: PublicSettings;
}

export interface RoomRoundClose {
  n: number;
  answer: WorldGuess;
  results: RoomRoundResult[];
}

const DEFAULT_LEADERBOARD_LIMIT = 50;
const MAX_LEADERBOARD_LIMIT = 200;
const ROOM_KINDS: readonly GameKind[] = ['party', 'duel'];

interface Loaded {
  game: GameRecord;
  challenge: ChallengeRecord;
  rounds: RoundRecord[];
}

export class GameService {
  readonly events: Emitter<GameEvents>;
  private readonly repo: Repository;
  private readonly worlds: WorldRegistry;
  private readonly clock: () => number;
  private readonly secret: string;
  private readonly mutex = new KeyedMutex();

  constructor(deps: GameServiceDeps) {
    this.repo = deps.repo;
    this.worlds = deps.worlds;
    this.clock = deps.clock;
    this.secret = deps.secret;
    this.events = deps.events ?? new Emitter<GameEvents>();
  }

  /** Slugs of the loaded worlds in display order. */
  get worldSlugs(): string[] {
    return worldSlugs(this.worlds);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Creating and joining games
  // -------------------------------------------------------------------------------------------------------------------

  async createSolo(playerId: string, rawSettings: unknown): Promise<GameView> {
    const settings = parseSettings(rawSettings, this.worldSlugs, 'solo');
    const challenge = await this.insertNewChallenge({ kind: 'solo', settings, createdBy: playerId, roomCode: null, status: 'open' });
    const game = await this.insertGame(challenge, playerId, 'solo', null);
    return this.getGame(game.id, playerId);
  }

  async joinChallenge(playerId: string, code: string): Promise<GameView> {
    const challenge = await this.repo.getChallenge(code);
    if (!challenge) throw new ApiFailure('not_found', 'challenge');
    let kind: GameKind = 'challenge';
    if (challenge.kind === 'daily') {
      if (challenge.date !== utcDate(this.clock())) throw new ApiFailure('forbidden', 'only today\'s daily can be played');
      kind = 'daily';
    }
    if (challenge.status === 'running') throw new ApiFailure('conflict', 'room game still running');
    const existing = await this.repo.getGameOf(challenge.code, playerId);
    if (existing) {
      if (existing.finishedAt !== null) throw new ApiFailure('already_played');
      return this.getGame(existing.id, playerId);
    }
    const game = await this.insertGame(challenge, playerId, kind, null);
    if (game.finishedAt !== null) throw new ApiFailure('already_played');
    return this.getGame(game.id, playerId);
  }

  async joinDaily(playerId: string): Promise<GameView> {
    const challenge = await this.ensureDaily(utcDate(this.clock()));
    return this.joinChallenge(playerId, challenge.code);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Playing
  // -------------------------------------------------------------------------------------------------------------------

  async getGame(gameId: string, playerId: string): Promise<GameView> {
    return this.mutex.run(gameId, async () => {
      const loaded = await this.loadOwned(gameId, playerId);
      await this.expireOpenRound(loaded);
      return this.buildView(loaded, await this.pendingRoomRounds(loaded));
    });
  }

  async openRound(gameId: string, playerId: string): Promise<RoundView> {
    return this.mutex.run(gameId, async () => {
      const loaded = await this.loadOwned(gameId, playerId);
      if (loaded.game.roomCode !== null) throw new ApiFailure('forbidden', 'rounds of room games are opened by the room');
      await this.expireOpenRound(loaded);
      if (loaded.game.finishedAt !== null) throw new ApiFailure('conflict', 'game finished');
      const open = openRoundOf(loaded.rounds);
      if (open) return this.roundView(loaded.challenge, open);
      const n = loaded.rounds.length + 1;
      if (n > loaded.challenge.rounds) throw new ApiFailure('conflict', 'no rounds left');
      const now = this.clock();
      const tl = loaded.challenge.settings.timeLimit;
      const round = await this.insertRoundRow(loaded.game.id, loaded.challenge, n, now, tl > 0 ? now + tl * 1000 : null);
      return this.roundView(loaded.challenge, round);
    });
  }

  async getNode(gameId: string, playerId: string, key: string): Promise<PanoNode> {
    return this.mutex.run(gameId, async () => {
      const loaded = await this.loadOwned(gameId, playerId);
      const expired = await this.expireOpenRound(loaded);
      const open = openRoundOf(loaded.rounds);
      if (!open) throw new ApiFailure(expired ? 'round_over' : 'not_found', 'no open round');
      const world = requireWorld(this.worlds, open.world);
      const node = nodeByKey(world, key);
      if (!node) throw new ApiFailure('not_found', 'node');
      const canMove = !loaded.challenge.settings.noMove;
      if (!reachable(world.manifest.nodes, world.idByKey, open, key, canMove)) throw new ApiFailure('not_found', 'node');
      const seen = open.seen.includes(key) ? open.seen : [...open.seen, key];
      if (seen !== open.seen || open.currentKey !== key) {
        await this.repo.updateRoundPosition(gameId, open.n, seen, key);
      }
      return toPanoNode(world, node, canMove);
    });
  }

  async guess(gameId: string, playerId: string, rawGuess: unknown): Promise<RoundResultView> {
    return this.mutex.run(gameId, async () => {
      const loaded = await this.loadOwned(gameId, playerId);
      const guess = this.parseGuess(rawGuess, loaded.challenge.settings);
      const open = openRoundOf(loaded.rounds);
      if (!open) throw new ApiFailure('round_over', 'no open round');
      const now = this.clock();
      const outcome =
        open.deadline !== null && now > open.deadline + DEADLINE_GRACE_MS
          ? this.timeoutOutcome(open, now)
          : this.scoreOutcome(open, guess, now);
      const result = await this.recordOutcome(loaded, open, outcome, true);
      return (await this.pendingRoomRounds(loaded)).has(result.n) ? pendingResult(result) : result;
    });
  }

  async summary(gameId: string, playerId: string, origin: string): Promise<GameSummaryView> {
    const game = await this.getGame(gameId, playerId);
    if (!game.finished) throw new ApiFailure('conflict', 'game not finished');
    const leaderboard = await this.leaderboard(game.challengeCode, playerId, DEFAULT_LEADERBOARD_LIMIT);
    const view: GameSummaryView = { game, leaderboard };
    if (game.kind === 'daily' && game.date) {
      const maxScore = this.maxScore(game.settings.worlds);
      view.shareText = dailyShareText({ date: game.date, results: game.results, maxTotal: maxScore * game.totalRounds, origin });
    }
    return view;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Challenges, leaderboards, daily
  // -------------------------------------------------------------------------------------------------------------------

  async challengeView(code: string, playerId: string | null): Promise<ChallengeView> {
    const challenge = await this.repo.getChallenge(code);
    if (!challenge) throw new ApiFailure('not_found', 'challenge');
    return this.toChallengeView(challenge, playerId);
  }

  async leaderboard(code: string, playerId: string | null, limit = DEFAULT_LEADERBOARD_LIMIT): Promise<LeaderboardView> {
    const challenge = await this.repo.getChallenge(code);
    if (!challenge) throw new ApiFailure('not_found', 'challenge');
    // A running room game: players who already guessed the last round are finished, but the round is not over for
    // the others yet. Nothing is listed until the room finishes the challenge.
    if (challenge.status === 'running') return { code, entries: [], me: null, total: 0 };
    const capped = Math.max(1, Math.min(MAX_LEADERBOARD_LIMIT, Math.floor(limit) || DEFAULT_LEADERBOARD_LIMIT));
    const rows = await this.repo.leaderboard(code, capped);
    const entries = rows.map((r, i) => toEntry(r, i + 1, playerId));
    let me: LeaderboardEntry | null = entries.find((e) => e.me) ?? null;
    if (!me && playerId) {
      const game = await this.repo.getGameOf(code, playerId);
      if (game) {
        const row = await this.repo.leaderboardEntry(code, game.id);
        if (row) me = toEntry(row, row.rank, playerId);
      }
    }
    return { code, entries, me, total: await this.repo.countLeaderboard(code) };
  }

  async dailyView(date: string | null, playerId: string | null): Promise<ChallengeView> {
    const today = utcDate(this.clock());
    const day = date ?? today;
    if (!isIsoDate(day)) throw new ApiFailure('bad_request', 'date');
    if (day > today) throw new ApiFailure('not_found', 'future daily');
    // Only today is created lazily; a past day nobody played has no challenge (and crawling dates creates no rows).
    const challenge = day === today ? await this.ensureDaily(day) : await this.repo.getDailyChallenge(day);
    if (!challenge) throw new ApiFailure('not_found', 'no daily on that date');
    return this.toChallengeView(challenge, playerId);
  }

  /** The daily challenge of `date`, created (seed from SERVER_SECRET, override or default settings) when missing. */
  async ensureDaily(date: string): Promise<ChallengeRecord> {
    const existing = await this.repo.getDailyChallenge(date);
    if (existing) return existing;
    const { settings } = await this.dailySettings(date);
    const seed = await dailySeed(this.secret, date);
    const picks = this.drawPicks(settings, seed, settings.rounds);
    const record: ChallengeRecord = {
      code: dailyCode(date),
      kind: 'daily',
      seed,
      settings: { ...settings, rounds: picks.length },
      rounds: picks.length,
      picks,
      createdBy: null,
      createdAt: this.clock(),
      date,
      roomCode: null,
      status: 'open',
    };
    if (await this.repo.insertChallenge(record)) return record;
    const raced = await this.repo.getDailyChallenge(date);
    if (!raced) throw new Error(`daily: could not create ${date}`);
    return raced;
  }

  /** Settings of a day: the admin override (reduced to loaded worlds) or the defaults. */
  async dailySettings(date: string): Promise<{ settings: PublicSettings; overridden: boolean }> {
    const override = await this.repo.getDailyOverride(date);
    const usable = override && settingsForLoadedWorlds(override, this.worldSlugs);
    if (usable) return { settings: usable, overridden: true };
    return { settings: defaultDailySettings(this.worldSlugs), overridden: false };
  }

  /** Admin: override a day's settings (see the header). */
  async setDailyOverride(date: string, rawSettings: unknown, opts: { force?: boolean } = {}): Promise<ChallengeView> {
    if (!isIsoDate(date)) throw new ApiFailure('bad_request', 'date');
    const settings = parseSettings(rawSettings, this.worldSlugs, 'daily');
    await this.redrawDaily(date, settings, opts.force === true, () => this.repo.setDailyOverride(date, settings, this.clock()));
    return this.toChallengeView(await this.ensureDaily(date), null);
  }

  /** Admin: remove a day's override (back to defaults), same `force` rule. */
  async clearDailyOverride(date: string, opts: { force?: boolean } = {}): Promise<ChallengeView> {
    if (!isIsoDate(date)) throw new ApiFailure('bad_request', 'date');
    const settings = defaultDailySettings(this.worldSlugs);
    await this.redrawDaily(date, settings, opts.force === true, () => this.repo.deleteDailyOverride(date));
    return this.toChallengeView(await this.ensureDaily(date), null);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Room API (see the header)
  // -------------------------------------------------------------------------------------------------------------------

  async createRoomGames(opts: {
    type: RoomType;
    settings: unknown;
    roomCode: string;
    hostId: string;
    playerIds: readonly string[];
  }): Promise<RoomGamesResult> {
    if (opts.playerIds.length === 0) throw new ApiFailure('bad_request', 'no players');
    const settings = parseSettings(opts.settings, this.worldSlugs, opts.type);
    const challenge = await this.insertNewChallenge({
      kind: opts.type,
      settings,
      createdBy: opts.hostId,
      roomCode: opts.roomCode,
      status: 'running',
    });
    const games: Record<string, string> = {};
    for (const playerId of new Set(opts.playerIds)) {
      const game = await this.insertGame(challenge, playerId, opts.type, opts.roomCode);
      games[playerId] = game.id;
    }
    return { challengeCode: challenge.code, games, rounds: challenge.rounds, settings: challenge.settings };
  }

  async openRoomRound(
    challengeCode: string,
    n: number,
    opts: { startedAt: number; deadline: number | null },
  ): Promise<{ n: number; node: PanoNode }> {
    const challenge = await this.requireRoomChallenge(challengeCode);
    if (!Number.isInteger(n) || n < 1 || n > challenge.picks.length) throw new ApiFailure('bad_request', `round ${n}`);
    for (const game of await this.roomGames(challenge)) {
      if (game.finishedAt !== null) continue;
      await this.mutex.run(game.id, async () => {
        const rounds = await this.repo.listRounds(game.id);
        const loaded: Loaded = { game, challenge, rounds };
        for (const r of rounds) {
          if (r.finishedAt === null && r.n < n) await this.recordOutcome(loaded, r, this.timeoutOutcome(r, opts.startedAt), false);
        }
        for (let m = rounds.length + 1; m < n; m++) {
          // A round this game never got (should not happen): record it as missed.
          const missed = await this.insertRoundRow(game.id, challenge, m, opts.startedAt, opts.startedAt);
          loaded.rounds.push(missed);
          await this.recordOutcome(loaded, missed, this.timeoutOutcome(missed, opts.startedAt), false);
        }
        if (!rounds.some((r) => r.n === n)) await this.insertRoundRow(game.id, challenge, n, opts.startedAt, opts.deadline);
      });
    }
    const pick = challenge.picks[n - 1]!;
    const world = requireWorld(this.worlds, pick.world);
    return { n, node: toPanoNode(world, requireNodeByKey(world, pick.key), !challenge.settings.noMove) };
  }

  async setRoomRoundDeadline(challengeCode: string, n: number, deadline: number | null): Promise<void> {
    const challenge = await this.requireRoomChallenge(challengeCode);
    for (const game of await this.roomGames(challenge)) {
      await this.mutex.run(game.id, async () => {
        const round = (await this.repo.listRounds(game.id)).find((r) => r.n === n);
        if (round && round.finishedAt === null) await this.repo.setRoundDeadline(game.id, n, deadline);
      });
    }
  }

  async closeRoomRound(challengeCode: string, n: number): Promise<RoomRoundClose> {
    const challenge = await this.requireRoomChallenge(challengeCode);
    const pick = challenge.picks[n - 1];
    if (!pick) throw new ApiFailure('bad_request', `round ${n}`);
    const now = this.clock();
    const results: RoomRoundResult[] = [];
    for (const game of await this.roomGames(challenge)) {
      const round = await this.mutex.run(game.id, async () => {
        const fresh = (await this.repo.getGame(game.id)) ?? game;
        const rounds = await this.repo.listRounds(game.id);
        const r = rounds.find((x) => x.n === n);
        if (r && r.finishedAt === null) {
          const outcome = this.timeoutOutcome(r, now);
          await this.recordOutcome({ game: fresh, challenge, rounds }, r, outcome, false);
          return { ...r, ...outcome };
        }
        return r ?? null;
      });
      results.push({
        playerId: game.playerId,
        guess: round?.guess ?? null,
        distanceM: round?.distanceM ?? null,
        score: round?.score ?? 0,
        timeMs: round?.timeMs ?? 0,
      });
    }
    return { n, answer: this.answerOf(pick), results };
  }

  async finishRoomChallenge(challengeCode: string, roundsPlayed: number): Promise<void> {
    const challenge = await this.requireRoomChallenge(challengeCode);
    const played = Math.max(0, Math.min(challenge.picks.length, Math.floor(roundsPlayed)));
    const now = this.clock();
    for (const game of await this.roomGames(challenge)) {
      await this.mutex.run(game.id, async () => {
        const fresh = (await this.repo.getGame(game.id)) ?? game;
        const rounds = await this.repo.listRounds(game.id);
        const loaded: Loaded = { game: fresh, challenge, rounds };
        for (const r of rounds) {
          if (r.finishedAt === null) await this.recordOutcome(loaded, r, this.timeoutOutcome(r, now), false);
        }
        if (loaded.game.finishedAt === null) await this.finishGameRow(loaded, now);
      });
    }
    // A room game aborted before its first round leaves an empty challenge: keep it unplayable (status running).
    if (played === 0) return;
    await this.repo.updateChallenge(challenge.code, {
      rounds: played,
      picks: challenge.picks.slice(0, played),
      settings: { ...challenge.settings, rounds: played },
      status: 'open',
    });
  }

  /**
   * Startup clean-up: room challenges still `running` belong to rooms of a previous process (rooms live in memory, so
   * none of them can be running now). Each is finished like a room closed by the admin: open rounds become timeouts,
   * every game is finished, and the challenge is cut to the rounds that were opened and opens its link. One that never
   * opened a round stays `running` and its view says `unavailable: 'abandoned'`. Returns the codes it handled.
   * Call it once before the rooms module accepts players.
   */
  async recoverRoomChallenges(): Promise<string[]> {
    const done: string[] = [];
    for (const code of await this.repo.listRunningChallenges()) {
      const challenge = await this.repo.getChallenge(code);
      if (!challenge || challenge.status !== 'running' || (challenge.kind !== 'party' && challenge.kind !== 'duel')) continue;
      const games = await this.roomGames(challenge);
      let played = 0;
      for (const game of games) {
        for (const r of await this.repo.listRounds(game.id)) played = Math.max(played, r.n);
      }
      // Already handled (abandoned before round 1): nothing left to do.
      if (played === 0 && games.every((g) => g.finishedAt !== null)) continue;
      await this.finishRoomChallenge(code, played);
      done.push(code);
    }
    return done;
  }

  async listChallengeGames(challengeCode: string): Promise<GameRecord[]> {
    return this.repo.listGamesOfChallenge(challengeCode);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------------------------------

  private async insertNewChallenge(opts: {
    kind: ChallengeRecord['kind'];
    settings: PublicSettings;
    createdBy: string | null;
    roomCode: string | null;
    status: ChallengeRecord['status'];
  }): Promise<ChallengeRecord> {
    const seed = randomSeed();
    const picks = this.drawPicks(opts.settings, seed, opts.settings.rounds);
    const rounds = picks.length;
    const settings = opts.kind === 'duel' ? opts.settings : { ...opts.settings, rounds };
    for (let attempt = 0; attempt < 8; attempt++) {
      const record: ChallengeRecord = {
        code: newChallengeCode(),
        kind: opts.kind,
        seed,
        settings,
        rounds,
        picks,
        createdBy: opts.createdBy,
        createdAt: this.clock(),
        date: null,
        roomCode: opts.roomCode,
        status: opts.status,
      };
      if (await this.repo.insertChallenge(record)) return record;
    }
    throw new Error('challenge: could not find a free code');
  }

  private async insertGame(challenge: ChallengeRecord, playerId: string, kind: GameKind, roomCode: string | null): Promise<GameRecord> {
    const game: GameRecord = {
      id: randomId(),
      challengeCode: challenge.code,
      playerId,
      kind,
      roomCode,
      createdAt: this.clock(),
      finishedAt: null,
      total: 0,
      timeMs: 0,
      hidden: false,
    };
    if (await this.repo.insertGame(game)) return game;
    const existing = await this.repo.getGameOf(challenge.code, playerId);
    if (!existing) throw new Error('game: insert refused but no existing game');
    return existing;
  }

  /** Start nodes of every round for (settings, seed), as stable keys. Throws `bad_request` when no start exists. */
  private drawPicks(settings: PublicSettings, seed: number, count: number): RoundPick[] {
    const locations = pickRounds(this.worlds, { seed, mode: settings.mode, worlds: settings.worlds }, count);
    if (locations.length === 0) throw new ApiFailure('bad_request', 'no starts for these settings');
    return locations.map((loc) => {
      const node = requireWorld(this.worlds, loc.world).manifest.nodes[loc.nodeId]!;
      return { world: loc.world, key: node.key };
    });
  }

  private async redrawDaily(date: string, settings: PublicSettings, force: boolean, store: () => Promise<void>): Promise<void> {
    const challenge = await this.repo.getDailyChallenge(date);
    if (challenge && !force && (await this.repo.countGames(challenge.code)) > 0) {
      throw new ApiFailure('conflict', 'the day already has games; pass force');
    }
    await store();
    if (challenge) {
      const picks = this.drawPicks(settings, challenge.seed, settings.rounds);
      await this.repo.updateChallenge(challenge.code, { settings: { ...settings, rounds: picks.length }, rounds: picks.length, picks });
    }
  }

  private async loadOwned(gameId: string, playerId: string): Promise<Loaded> {
    const game = await this.repo.getGame(gameId);
    if (!game || game.playerId !== playerId) throw new ApiFailure('not_found', 'game');
    const challenge = await this.repo.getChallenge(game.challengeCode);
    if (!challenge) throw new Error(`game ${gameId}: challenge ${game.challengeCode} is missing`);
    return { game, challenge, rounds: await this.repo.listRounds(gameId) };
  }

  private async requireRoomChallenge(code: string): Promise<ChallengeRecord> {
    const challenge = await this.repo.getChallenge(code);
    if (!challenge || (challenge.kind !== 'party' && challenge.kind !== 'duel')) throw new ApiFailure('not_found', 'room challenge');
    return challenge;
  }

  /** The room players' games of a room challenge (not friends' later `challenge` games), in creation order. */
  private async roomGames(challenge: ChallengeRecord): Promise<GameRecord[]> {
    const games = await this.repo.listGamesOfChallenge(challenge.code);
    return games.filter((g) => g.roomCode !== null && ROOM_KINDS.includes(g.kind));
  }

  private async insertRoundRow(
    gameId: string,
    challenge: ChallengeRecord,
    n: number,
    startedAt: number,
    deadline: number | null,
  ): Promise<RoundRecord> {
    const pick = challenge.picks[n - 1];
    if (!pick) throw new ApiFailure('conflict', `round ${n} does not exist`);
    const round: RoundRecord = {
      gameId,
      n,
      world: pick.world,
      key: pick.key,
      startedAt,
      deadline,
      finishedAt: null,
      guess: null,
      distanceM: null,
      score: 0,
      timeMs: 0,
      timedOut: false,
      seen: [pick.key],
      currentKey: pick.key,
    };
    if (!(await this.repo.insertRound(round))) {
      const existing = (await this.repo.listRounds(gameId)).find((r) => r.n === n);
      if (!existing) throw new Error(`round ${gameId}/${n}: insert refused but missing`);
      return existing;
    }
    return round;
  }

  /** Close the open round as a timeout when its deadline + grace has passed. Returns true when it did. */
  private async expireOpenRound(loaded: Loaded): Promise<boolean> {
    const open = openRoundOf(loaded.rounds);
    const now = this.clock();
    if (!open || open.deadline === null || now <= open.deadline + DEADLINE_GRACE_MS) return false;
    await this.recordOutcome(loaded, open, this.timeoutOutcome(open, now), true);
    return true;
  }

  private timeoutOutcome(round: RoundRecord, now: number): RoundOutcome {
    const end = round.deadline !== null ? Math.min(now, round.deadline) : now;
    return { finishedAt: now, guess: null, distanceM: null, score: 0, timeMs: Math.max(0, end - round.startedAt), timedOut: true };
  }

  private scoreOutcome(round: RoundRecord, guess: WorldGuess | null, now: number): RoundOutcome {
    const end = round.deadline !== null ? Math.min(now, round.deadline) : now;
    const timeMs = Math.max(0, end - round.startedAt);
    const timedOut = guess === null && round.deadline !== null && now >= round.deadline;
    if (!guess) return { finishedAt: now, guess: null, distanceM: null, score: 0, timeMs, timedOut };
    const world = requireWorld(this.worlds, round.world);
    const node = requireNodeByKey(world, round.key);
    const { distanceM, score } = scoreForGuess(guess, { world: round.world, nodeId: node.id }, world.manifest);
    return {
      finishedAt: now,
      guess,
      distanceM: distanceM === null ? null : Math.round(distanceM * 10) / 10,
      score,
      timeMs,
      timedOut: false,
    };
  }

  /**
   * Persist a round outcome (CAS), update the game's running totals, finish the game after its last round and emit
   * events (`emit` false for room-driven closes). Mutates `loaded` to reflect the new state.
   */
  private async recordOutcome(loaded: Loaded, round: RoundRecord, outcome: RoundOutcome, emit: boolean): Promise<RoundResultView> {
    if (!(await this.repo.finishRound(round.gameId, round.n, outcome))) throw new ApiFailure('round_over', 'round already over');
    Object.assign(round, outcome);
    const finished = loaded.rounds.filter((r) => r.finishedAt !== null);
    const total = finished.reduce((s, r) => s + r.score, 0);
    const timeMs = finished.reduce((s, r) => s + r.timeMs, 0);
    await this.repo.updateGameTotals(loaded.game.id, total, timeMs);
    loaded.game = { ...loaded.game, total, timeMs };
    const isLast = round.n >= loaded.challenge.rounds && loaded.game.finishedAt === null;
    if (isLast) await this.finishGameRow(loaded, outcome.finishedAt);
    const result = this.resultView(round);
    if (emit) {
      this.events.emit('guess', {
        gameId: loaded.game.id,
        playerId: loaded.game.playerId,
        challengeCode: loaded.challenge.code,
        kind: loaded.game.kind,
        roomCode: loaded.game.roomCode,
        n: round.n,
        result,
        gameFinished: isLast,
        at: outcome.finishedAt,
      });
    }
    return result;
  }

  private async finishGameRow(loaded: Loaded, at: number): Promise<void> {
    if (!(await this.repo.finishGame(loaded.game.id, at))) return;
    loaded.game = { ...loaded.game, finishedAt: at };
    this.events.emit('gameFinished', {
      gameId: loaded.game.id,
      playerId: loaded.game.playerId,
      challengeCode: loaded.challenge.code,
      kind: loaded.game.kind,
      roomCode: loaded.game.roomCode,
      total: loaded.game.total,
      at,
    });
  }

  private parseGuess(raw: unknown, settings: PublicSettings): WorldGuess | null {
    if (raw === null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new ApiFailure('bad_request', 'guess');
    const g = raw as Record<string, unknown>;
    const { world, x, z } = g;
    if (typeof world !== 'string' || !settings.worlds.includes(world)) throw new ApiFailure('bad_request', 'guess.world');
    if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) {
      throw new ApiFailure('bad_request', 'guess.x/z');
    }
    if (Math.abs(x) > 1e8 || Math.abs(z) > 1e8) throw new ApiFailure('bad_request', 'guess out of range');
    return { world, x, z };
  }

  private answerOf(pick: RoundPick): WorldGuess {
    const node = requireNodeByKey(requireWorld(this.worlds, pick.world), pick.key);
    return { world: pick.world, x: node.x, z: node.z };
  }

  /**
   * Rounds this room game has finished while another room player of the same challenge still has them open (the room
   * has not closed them yet): their outcome must not be shown (alt accounts relaying the answer). Empty for non-room
   * games and once the room challenge is no longer `running`.
   */
  private async pendingRoomRounds({ game, challenge, rounds }: Loaded): Promise<Set<number>> {
    const pending = new Set<number>();
    if (game.roomCode === null || challenge.status !== 'running') return pending;
    const mine = new Set(rounds.filter((r) => r.finishedAt !== null).map((r) => r.n));
    if (mine.size === 0) return pending;
    for (const other of await this.roomGames(challenge)) {
      if (other.id === game.id || other.finishedAt !== null) continue;
      for (const r of await this.repo.listRounds(other.id)) {
        if (r.finishedAt === null && mine.has(r.n)) pending.add(r.n);
      }
    }
    return pending;
  }

  private resultView(r: RoundRecord): RoundResultView {
    return {
      n: r.n,
      guess: r.guess,
      answer: this.answerOf(r),
      distanceM: r.distanceM,
      score: r.score,
      timeMs: r.timeMs,
      timedOut: r.timedOut,
    };
  }

  private roundView(challenge: ChallengeRecord, r: RoundRecord): RoundView {
    const world = requireWorld(this.worlds, r.world);
    return {
      n: r.n,
      start: toPanoNode(world, requireNodeByKey(world, r.key), !challenge.settings.noMove),
      deadline: r.deadline,
      startedAt: r.startedAt,
    };
  }

  private buildView({ game, challenge, rounds }: Loaded, pending: ReadonlySet<number> = NONE): GameView {
    const finished = rounds.filter((r) => r.finishedAt !== null).sort((a, b) => a.n - b.n);
    const results = finished.map((r) => (pending.has(r.n) ? pendingResult(this.resultView(r)) : this.resultView(r)));
    const open = openRoundOf(rounds);
    const runningDuel = challenge.kind === 'duel' && challenge.status === 'running' && game.finishedAt === null;
    const view: GameView = {
      id: game.id,
      kind: game.kind,
      challengeCode: challenge.code,
      settings: { ...challenge.settings, worlds: [...challenge.settings.worlds] },
      totalRounds: runningDuel ? finished.length + 1 : challenge.rounds,
      results,
      current: open ? this.roundView(challenge, open) : null,
      currentKey: open ? open.currentKey : null,
      finished: game.finishedAt !== null,
      total: results.reduce((s, r) => s + r.score, 0),
    };
    if (game.roomCode !== null) view.roomCode = game.roomCode;
    if (challenge.date !== null) view.date = challenge.date;
    return view;
  }

  private async toChallengeView(challenge: ChallengeRecord, playerId: string | null): Promise<ChallengeView> {
    let createdBy: string | null = null;
    if (challenge.createdBy) createdBy = (await this.repo.getPlayer(challenge.createdBy))?.nickname ?? null;
    const game = playerId ? await this.repo.getGameOf(challenge.code, playerId) : null;
    let myTotal = game?.total ?? 0;
    if (game && challenge.status === 'running' && game.roomCode !== null) {
      // Same rule as getGame: a room round's score shows only once the round is over for everyone.
      const rounds = await this.repo.listRounds(game.id);
      const pending = await this.pendingRoomRounds({ game, challenge, rounds });
      myTotal = rounds.reduce((s, r) => s + (r.finishedAt !== null && !pending.has(r.n) ? r.score : 0), 0);
    }
    const view: ChallengeView = {
      code: challenge.code,
      kind: challenge.kind,
      settings: { ...challenge.settings, worlds: [...challenge.settings.worlds] },
      createdBy,
      createdAt: challenge.createdAt,
      players: challenge.status === 'running' ? 0 : await this.repo.countLeaderboard(challenge.code),
      myGame: game ? { id: game.id, finished: game.finishedAt !== null, total: myTotal } : null,
    };
    if (challenge.date !== null) view.date = challenge.date;
    if (challenge.status === 'running') {
      const games = await this.repo.listGamesOfChallenge(challenge.code);
      view.unavailable = games.length > 0 && games.every((g) => g.finishedAt !== null) ? 'abandoned' : 'running';
    }
    return view;
  }

  private maxScore(worlds: readonly string[]): number {
    let max = 0;
    for (const slug of worlds) {
      const w = this.worlds.get(slug);
      if (w) max = Math.max(max, w.manifest.scoring.maxScore);
    }
    return max || 5000;
  }
}

const NONE: ReadonlySet<number> = new Set();

/** A room result withheld until the room round closes (see RoundResultView.pending). */
function pendingResult(r: RoundResultView): RoundResultView {
  return { n: r.n, guess: r.guess, distanceM: null, score: 0, timeMs: r.timeMs, timedOut: r.timedOut, pending: true };
}

/** The unfinished round, if any (there is at most one). */
function openRoundOf(rounds: readonly RoundRecord[]): RoundRecord | undefined {
  return rounds.find((r) => r.finishedAt === null);
}

/**
 * Reach check (SPEC §10.4): `key` may be fetched when it is the round's start, was returned before in this round, or
 * is a link of such a node. With No move only the start is reachable.
 */
export function reachable(
  nodes: readonly { key: string; links: readonly { to: number }[] }[],
  idByKey: ReadonlyMap<string, number>,
  round: Pick<RoundRecord, 'key' | 'seen'>,
  key: string,
  canMove: boolean,
): boolean {
  if (key === round.key) return true;
  if (!canMove) return false;
  if (round.seen.includes(key)) return true;
  const target = idByKey.get(key);
  if (target === undefined) return false;
  for (const seenKey of round.seen) {
    const id = idByKey.get(seenKey);
    if (id === undefined) continue;
    if (nodes[id]?.links.some((l) => l.to === target)) return true;
  }
  return false;
}

function toEntry(row: LeaderboardRow, rank: number, playerId: string | null): LeaderboardEntry {
  return {
    rank,
    playerId: row.playerId,
    nickname: row.nickname,
    total: row.total,
    timeMs: row.timeMs,
    rounds: row.rounds,
    me: playerId !== null && row.playerId === playerId,
  };
}
