/**
 * Storage interface of the backend (SPEC §10.2). Core services only talk to this async interface; server/db/ implements
 * it with better-sqlite3 (a D1 implementation can replace it later). Records mirror the tables of server/db/schema.ts.
 *
 * Conventions: times are epoch ms; JSON columns are parsed/serialised by the implementation; "insert" methods return
 * false when a unique constraint refused the row instead of throwing; "CAS" methods return whether a row changed.
 */
import type { GameKind, ChallengeKind, PublicSettings, WorldGuess } from '../../shared/api';

export interface PlayerRecord {
  id: string;
  /** SHA-256 hex of the device token; the token itself is never stored. */
  tokenHash: string;
  nickname: string;
  banned: boolean;
  createdAt: number;
  lastSeenAt: number;
}

/** A round pick: the start node of round n, by world and stable node key. */
export interface RoundPick {
  world: string;
  key: string;
}

/** `running` = a room game is in progress (the link cannot be played yet); `open` = playable / finished room game. */
export type ChallengeStatus = 'open' | 'running';

export interface ChallengeRecord {
  code: string;
  kind: ChallengeKind;
  /** Secret PRNG seed (never sent to players). */
  seed: number;
  settings: PublicSettings;
  /** Rounds of the challenge (picks.length for solo/daily/party; duel: 30 while running, rounds played after). */
  rounds: number;
  picks: RoundPick[];
  createdBy: string | null;
  createdAt: number;
  /** Daily only (unique). */
  date: string | null;
  /** Room challenges: the room code at creation (codes are reused after a room expires). */
  roomCode: string | null;
  status: ChallengeStatus;
}

export interface GameRecord {
  id: string;
  challengeCode: string;
  playerId: string;
  kind: GameKind;
  roomCode: string | null;
  createdAt: number;
  finishedAt: number | null;
  /** Sum of finished round scores (kept up to date as rounds finish). */
  total: number;
  /** Sum of finished round times, ms. */
  timeMs: number;
  /** Admin moderation: hidden from leaderboards. */
  hidden: boolean;
}

export interface RoundRecord {
  gameId: string;
  /** 1-based. */
  n: number;
  world: string;
  /** Start node key (the answer). */
  key: string;
  startedAt: number;
  deadline: number | null;
  /** Set once the round is over (guess, give up or timeout). */
  finishedAt: number | null;
  guess: WorldGuess | null;
  distanceM: number | null;
  score: number;
  timeMs: number;
  timedOut: boolean;
  /** Keys returned to the player in this round (reach check, SPEC §10.4). Always contains the start key. */
  seen: string[];
  /** Last key the player fetched (resume position). */
  currentKey: string;
}

/** Fields written when a round finishes. */
export interface RoundOutcome {
  finishedAt: number;
  guess: WorldGuess | null;
  distanceM: number | null;
  score: number;
  timeMs: number;
  timedOut: boolean;
}

export interface LeaderboardRow {
  gameId: string;
  playerId: string;
  nickname: string;
  total: number;
  timeMs: number;
  finishedAt: number;
  /** Per-round scores, in round order. */
  rounds: number[];
}

export interface HitRecord {
  at: number;
  /** UTC date of `at`. */
  day: string;
  path: string;
  /** Host of the referrer (no path/query), '' for none or same-site. */
  referrerHost: string;
  visitor: string;
  lang: string | null;
  /** Page of the admin SPA. */
  admin: boolean;
}

export interface AuditRecord {
  at: number;
  action: string;
  target: string;
  details?: string;
}

export interface Repository {
  // Players
  insertPlayer(p: PlayerRecord): Promise<void>;
  getPlayer(id: string): Promise<PlayerRecord | null>;
  getPlayerByTokenHash(tokenHash: string): Promise<PlayerRecord | null>;
  updateNickname(id: string, nickname: string): Promise<void>;
  touchPlayer(id: string, at: number): Promise<void>;
  /** Ban/unban; also appends to the bans history. */
  setBanned(id: string, banned: boolean, at: number, reason?: string): Promise<void>;

  // Challenges
  /** False when the code (or the daily date) already exists. */
  insertChallenge(c: ChallengeRecord): Promise<boolean>;
  getChallenge(code: string): Promise<ChallengeRecord | null>;
  getDailyChallenge(date: string): Promise<ChallengeRecord | null>;
  updateChallenge(code: string, patch: Partial<Pick<ChallengeRecord, 'settings' | 'rounds' | 'picks' | 'status'>>): Promise<void>;
  /** Finished, visible (not hidden, player not banned) games of a challenge. */
  countLeaderboard(code: string): Promise<number>;
  /** Any games at all (started or finished) for a challenge. */
  countGames(code: string): Promise<number>;
  /** Codes of the challenges in status `running` (room games in progress, or left over by a crash). */
  listRunningChallenges(): Promise<string[]>;

  // Games
  /** False when the player already has a game in this challenge. */
  insertGame(g: GameRecord): Promise<boolean>;
  getGame(id: string): Promise<GameRecord | null>;
  getGameOf(challengeCode: string, playerId: string): Promise<GameRecord | null>;
  listGamesOfChallenge(challengeCode: string): Promise<GameRecord[]>;
  /** Sets total/timeMs (running sums). */
  updateGameTotals(id: string, total: number, timeMs: number): Promise<void>;
  /** CAS: only an unfinished game is finished. */
  finishGame(id: string, at: number): Promise<boolean>;

  // Rounds
  listRounds(gameId: string): Promise<RoundRecord[]>;
  /** False when round n of the game already exists. */
  insertRound(r: RoundRecord): Promise<boolean>;
  /** Reach-check bookkeeping of an open round. */
  updateRoundPosition(gameId: string, n: number, seen: string[], currentKey: string): Promise<void>;
  /** CAS: only an unfinished round is finished. */
  finishRound(gameId: string, n: number, outcome: RoundOutcome): Promise<boolean>;
  /** Change the deadline of an open round (duel countdown). */
  setRoundDeadline(gameId: string, n: number, deadline: number | null): Promise<void>;

  // Leaderboards
  /** Visible finished games, ordered (see core/leaderboard.ts), at most `limit`. */
  leaderboard(challengeCode: string, limit: number): Promise<LeaderboardRow[]>;
  /** The visible finished game with its 1-based rank, or null when not visible/finished. */
  leaderboardEntry(challengeCode: string, gameId: string): Promise<(LeaderboardRow & { rank: number }) | null>;

  // Daily overrides
  getDailyOverride(date: string): Promise<PublicSettings | null>;
  setDailyOverride(date: string, settings: PublicSettings, at: number): Promise<void>;
  deleteDailyOverride(date: string): Promise<void>;

  // Analytics
  insertHit(h: HitRecord): Promise<void>;

  // Moderation
  listBlockedWords(): Promise<string[]>;
  addBlockedWord(word: string, at: number): Promise<void>;
  removeBlockedWord(word: string): Promise<void>;
  addAudit(entry: AuditRecord): Promise<void>;
  listAudit(limit: number, beforeAt?: number): Promise<AuditRecord[]>;

  // Rooms (log only; live rooms are in memory)
  logRoomCreated(code: string, type: 'party' | 'duel', hostId: string, at: number): Promise<void>;
  logRoomClosed(code: string, at: number): Promise<void>;
}
