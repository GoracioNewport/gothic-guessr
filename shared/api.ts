/**
 * Stage 3 API contract (SPEC.md section 10): every REST payload and WebSocket message exchanged between the client
 * (src/, src/admin/) and the server (server/). Both sides import this file; it must stay free of runtime imports
 * so it compiles in the browser, in Node and in a Worker.
 *
 * Rules for implementers working in parallel:
 * - Extend additively (new optional fields, new types, new error codes). Never rename/remove without updating
 *   every user and SPEC.md §10.
 * - Nothing in a player-facing payload may reveal a node's coordinates, waypoint name, world (before the guess),
 *   or a seed. Admin payloads may.
 * - Times are epoch milliseconds (server clock) unless named `...Ms` for a duration.
 * - Coordinates follow src/contracts.ts: game centimetres, `{x, z}` horizontal plane, per world.
 */

// ---------------------------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------------------------

export type GameMode = 'classic' | 'mixed' | 'hardcore';
export type Lang = 'en' | 'de' | 'pl' | 'ru';
export const LANGS: readonly Lang[] = ['en', 'de', 'pl', 'ru'];

/** Machine-readable error codes; the client localizes them (SPEC §10.4). */
export type ApiErrorCode =
  | 'auth'
  | 'not_found'
  | 'forbidden'
  | 'banned'
  | 'rate_limited'
  | 'nickname_rejected'
  | 'already_played'
  | 'room_full'
  | 'room_started'
  | 'room_closed'
  | 'not_host'
  | 'bad_request'
  | 'round_over'
  | 'conflict'
  | 'internal';

/** Body of every non-2xx response. `message` is for logs/devtools only, never shown to players. */
export interface ApiError {
  error: ApiErrorCode;
  message?: string;
}

/** Allowed per-round time limits in seconds; 0 = no limit. */
export const TIME_LIMITS: readonly number[] = [0, 30, 60, 120, 300];

/** GET /api/config: public site settings (no auth). */
export interface PublicConfigView {
  /** Contact for rights holders and data requests (server env PUBLIC_CONTACT): an e-mail address, a URL or plain
   *  text; null when not configured. */
  contact: string | null;
}

/** Allowed round counts of a quick play (solo) game and of a party room; 5 is the default. */
export const ROUND_COUNTS: readonly number[] = [3, 5, 10];

/**
 * Settings of a game as players see them (no seed). Solo setup sends this; challenges/rooms echo it.
 * `rounds` is 3|5|10 for solo (a challenge inherits it from its solo game) and party, 5 for daily; for a duel it is
 * the cap (30).
 */
export interface PublicSettings {
  mode: GameMode;
  /** Enabled world slugs in worlds.json order, never empty. */
  worlds: string[];
  noMove: boolean;
  /** Implies noMove. */
  noLook: boolean;
  /** Seconds per round, one of TIME_LIMITS; 0 = none. */
  timeLimit: number;
  rounds: number;
}

export interface WorldGuess {
  world: string;
  x: number;
  z: number;
}

// ---------------------------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------------------------

export interface PlayerView {
  id: string;
  nickname: string;
  /** Banned players can play solo but appear on no leaderboard and cannot use rooms. */
  banned: boolean;
  createdAt: number;
}

/** POST /api/players (body optional): `lang` picks the language of the default nickname (`Nameless Hero 0427`). */
export interface CreatePlayerRequest {
  lang?: Lang;
}

/** POST /api/players */
export interface CreatePlayerResponse {
  /** Device token; store in localStorage `gothic2guessr.token`, send as `Authorization: Bearer <token>`. */
  token: string;
  player: PlayerView;
}

/** PATCH /api/me */
export interface UpdateMeRequest {
  nickname: string;
}

// ---------------------------------------------------------------------------------------------
// Panorama nodes (the only node data a player ever receives)
// ---------------------------------------------------------------------------------------------

export interface PanoLink {
  /** Opaque key of the target node. */
  key: string;
  /** Degrees clockwise from north, [0, 360). */
  yaw: number;
  /** Degrees above the horizon. */
  pitch: number;
}

/** A node: tiles live at `<data base>/panos/<key>/…` (layout from world.json `pano`). */
export interface PanoNode {
  key: string;
  links: PanoLink[];
}

// ---------------------------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------------------------

export type GameKind = 'solo' | 'daily' | 'challenge' | 'party' | 'duel';
export type ChallengeKind = 'solo' | 'daily' | 'party' | 'duel';

/** POST /api/games */
export type CreateGameRequest =
  | { kind: 'solo'; settings: PublicSettings }
  | { kind: 'challenge'; code: string }
  | { kind: 'daily' };

/** Result of one finished round, as the player sees it after guessing. */
export interface RoundResultView {
  /** 1-based. */
  n: number;
  /** null = no guess (gave up or timed out). */
  guess: WorldGuess | null;
  /** Revealed only now. Absent while `pending`. */
  answer?: WorldGuess;
  /** null when the guess is missing or in another world (and while `pending`). */
  distanceM: number | null;
  /** 0 while `pending`. */
  score: number;
  /**
   * Room games only: the player's guess is recorded but round n is still open for another room player, so answer,
   * distance and score are withheld (the room's `roundResult` reveals them; GET /games/:id has them once the round
   * closed). Absent otherwise.
   */
  pending?: true;
  /** Time from round start to guess (or to the deadline on timeout), ms. */
  timeMs: number;
  timedOut: boolean;
}

/** An open round. */
export interface RoundView {
  n: number;
  /** Start node of the round (also the "Return to start" target). */
  start: PanoNode;
  /** Epoch ms when the round closes, or null when untimed. */
  deadline: number | null;
  startedAt: number;
}

export interface GameView {
  id: string;
  kind: GameKind;
  challengeCode: string;
  settings: PublicSettings;
  /** Total rounds of this game (duel: rounds played so far + 1 while running). */
  totalRounds: number;
  /** Results of finished rounds, in order. */
  results: RoundResultView[];
  /** The open round, if any. */
  current: RoundView | null;
  /** Key of the node the player last fetched in the open round (resume position). */
  currentKey: string | null;
  finished: boolean;
  total: number;
  /** For room games: the room code (client reconnects to the room instead of driving rounds itself). */
  roomCode?: string;
  /** For daily games: the UTC date. */
  date?: string;
}

/** POST /api/games/:id/guess */
export interface GuessRequest {
  guess: WorldGuess | null;
}

export interface GameSummaryView {
  game: GameView;
  /** Leaderboard of the game's challenge with the player's row. */
  leaderboard: LeaderboardView;
  /** Daily only: ready-to-copy share text (SPEC §10.5). */
  shareText?: string;
}

// ---------------------------------------------------------------------------------------------
// Challenges, daily, leaderboards
// ---------------------------------------------------------------------------------------------

export interface ChallengeView {
  code: string;
  kind: ChallengeKind;
  settings: PublicSettings;
  createdBy: string | null;
  createdAt: number;
  /** Finished games on the leaderboard. */
  players: number;
  myGame: { id: string; finished: boolean; total: number } | null;
  /** Daily: YYYY-MM-DD (UTC). */
  date?: string;
  /**
   * Room challenges that cannot be played (yet): `running` while the room still plays them, `abandoned` when the
   * room game ended before its first round (e.g. the server restarted), so the link never opens. Absent = playable.
   */
  unavailable?: 'running' | 'abandoned';
}

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  nickname: string;
  total: number;
  /** Sum of round times, ms (tie-break, lower is better). */
  timeMs: number;
  /** Per-round scores. */
  rounds: number[];
  me: boolean;
}

export interface LeaderboardView {
  code: string;
  entries: LeaderboardEntry[];
  /** The caller's entry even when outside `entries`, null if not played/finished. */
  me: LeaderboardEntry | null;
  total: number;
}

// ---------------------------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------------------------

/** POST /api/hits → 204 */
export interface HitRequest {
  path: string;
  referrer: string;
  /** Random id from localStorage `gothic2guessr.visitor`. */
  visitor: string;
  lang?: Lang;
}

// ---------------------------------------------------------------------------------------------
// Problem reports (players → admin; no replies)
// ---------------------------------------------------------------------------------------------

/** `location`: a bad panorama; `translation`: wrong or missing text; `bug`: something does not work. */
export type ReportType = 'location' | 'translation' | 'bug' | 'other';
export const REPORT_TYPES: readonly ReportType[] = ['location', 'translation', 'bug', 'other'];

/** Optional chips of a `location` report. */
export type ReportCategory = 'underground' | 'geometry' | 'floating' | 'visual' | 'other';
export const REPORT_CATEGORIES: readonly ReportCategory[] = ['underground', 'geometry', 'floating', 'visual', 'other'];

/** Longest report text, characters (code points). */
export const REPORT_TEXT_MAX = 1000;

export type ReportStatus = 'open' | 'resolved' | 'ignored';
export const REPORT_STATUSES: readonly ReportStatus[] = ['open', 'resolved', 'ignored'];

/**
 * Which panorama a `location` report is about. The server resolves it from the caller's OWN game and never echoes
 * anything back: without `round` → the open round (or else the last one) at the node the player stands on (the
 * server's resume position); with `round` → that round's start node (the summary's "round n"). `key`, when given,
 * must be a node the player was shown in that round.
 */
export interface ReportGameRef {
  gameId: string;
  round?: number;
  key?: string;
}

/** Client environment sent with a report (the user agent comes from the request header). */
export interface ReportClientContext {
  lang?: Lang;
  /** Client route, e.g. `/daily`. */
  path?: string;
  viewport?: { w: number; h: number };
  /** Build hash of the client bundle, `dev` in development. */
  appVersion?: string;
}

/**
 * POST /api/reports → 204. Rate limited (10/h per player, 30/h per IP). `text` is required (non-blank) except for a
 * `location` report that names a game; `categories` only for `location`.
 */
export interface CreateReportRequest {
  type: ReportType;
  text?: string;
  categories?: ReportCategory[];
  game?: ReportGameRef;
  context?: ReportClientContext;
}

/** Admin: the resolved panorama of a location report (private data). */
export interface AdminReportLocation {
  gameId: string;
  round: number;
  world: string;
  key: string;
  nodeId: number;
  waypoint: string;
  x: number;
  y: number;
  z: number;
  /** Start node of that round (differs from `key` when the player had walked away). */
  startKey: string;
  /** Path of the node's tiles: `<data base>/panos/<key>` (base faces `base_{front,right,back,left,top,bottom}.webp`). */
  panoPath: string;
}

export interface AdminReport {
  id: number;
  at: number;
  type: ReportType;
  status: ReportStatus;
  /** When the status last changed, null while never changed. */
  statusAt: number | null;
  categories: ReportCategory[];
  text: string;
  /** The reporter now (null when the player was deleted) and the nickname at report time. */
  player: { id: string; nickname: string; banned: boolean } | null;
  nickname: string | null;
  /** The reporter was banned when sending the report. */
  flagged: boolean;
  location: AdminReportLocation | null;
  lang: string | null;
  path: string | null;
  userAgent: string | null;
  viewport: string | null;
  appVersion: string | null;
}

/** GET /api/<ADMIN_PATH>/reports?status&type&world&limit&before → newest first; pass `next` as `before`. */
export interface AdminReportList {
  reports: AdminReport[];
  next: number | null;
  /** Matching reports in total (all pages). */
  total: number;
}

/** GET /api/<ADMIN_PATH>/reports/counts */
export interface AdminReportCounts {
  open: number;
  byStatus: Record<ReportStatus, number>;
  /** Open reports per type. */
  openByType: Record<ReportType, number>;
}

/** POST /api/<ADMIN_PATH>/reports/:id/status → AdminReport */
export interface AdminReportStatusRequest {
  status: ReportStatus;
}

// ---------------------------------------------------------------------------------------------
// Rooms (REST + WebSocket at /ws?token=…)
// ---------------------------------------------------------------------------------------------

export type RoomType = 'party' | 'duel';
export type RoomPhase = 'lobby' | 'round' | 'result' | 'over';

/** POST /api/rooms */
export interface CreateRoomRequest {
  type: RoomType;
  settings: PublicSettings;
}

export interface CreateRoomResponse {
  code: string;
}

export interface RoomPlayer {
  id: string;
  nickname: string;
  host: boolean;
  connected: boolean;
  /** Guessed in the current round. */
  guessed: boolean;
  /** Running total (party) once the game started. */
  total: number;
  /** Duel only. */
  hp?: number;
}

export interface RoomView {
  code: string;
  type: RoomType;
  phase: RoomPhase;
  settings: PublicSettings;
  players: RoomPlayer[];
  /** Max players: 16 party, 2 duel. */
  capacity: number;
  /** Current round number, 0 in the lobby. */
  round: number;
  /** Challenge of the running/last game (share link `/c/<code>`). */
  challengeCode: string | null;
  /** This player's game id while a game runs. */
  myGameId: string | null;
}

export interface DuelState {
  hp: Record<string, number>;
  multiplier: number;
}

export interface RoomRoundResult {
  playerId: string;
  guess: WorldGuess | null;
  distanceM: number | null;
  score: number;
  timeMs: number;
}

export interface Standing {
  playerId: string;
  nickname: string;
  total: number;
  timeMs: number;
  /** Duel only. */
  hp?: number;
}

export type GameOverReason = 'ko' | 'forfeit' | 'cap' | 'rounds';

/** Room codes: {@link ROOM_CODE_LENGTH} letters of this alphabet (no I, no O), e.g. `QWHTR`. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 5;

/**
 * Party: the host's `endRound` gives the players who have not guessed this long (their client submits a placed
 * marker before the deadline, see TIMEOUT_SUBMIT_LEAD_MS on the client).
 */
export const END_ROUND_COUNTDOWN_MS = 5_000;

export type ClientMessage =
  | { t: 'join'; code: string }
  | { t: 'leave' }
  | { t: 'settings'; type?: RoomType; settings: PublicSettings }
  | { t: 'kick'; playerId: string }
  | { t: 'start' }
  | { t: 'next' }
  /** Host, party round phase: end the round for everyone after a short countdown (`countdown {deadline}`). */
  | { t: 'endRound' }
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'room'; room: RoomView }
  | { t: 'kicked' }
  | { t: 'started'; gameId: string; challengeCode: string }
  | { t: 'round'; n: number; node: PanoNode; deadline: number | null; startedAt: number; duel?: DuelState }
  | { t: 'guessed'; playerId: string }
  | { t: 'countdown'; deadline: number }
  | {
      t: 'roundResult';
      n: number;
      answer: WorldGuess;
      results: RoomRoundResult[];
      duel?: DuelState & { damage: Record<string, number> };
      /** Party: epoch ms of the automatic advance. */
      nextAt?: number;
    }
  | {
      t: 'gameOver';
      standings: Standing[];
      winner?: string | null;
      challengeCode: string;
      /**
       * Why the game ended: `rounds` (party: last round played), `ko` (duel: someone at 0 HP), `cap` (duel: round cap
       * reached, higher HP wins), `forfeit` (duel: the loser left or stayed away too long). Absent when a game was cut
       * short by a server error.
       */
      reason?: GameOverReason;
    }
  | { t: 'error'; error: ApiErrorCode }
  | { t: 'pong' };

// ---------------------------------------------------------------------------------------------
// Admin (/api/<ADMIN_PATH>/*, cookie session) — may contain private data
// ---------------------------------------------------------------------------------------------

export interface AdminLoginRequest {
  password: string;
}

export interface AdminStatsDay {
  date: string;
  pageViews: number;
  visitors: number;
  newPlayers: number;
  gamesStarted: Record<GameKind, number>;
  gamesFinished: Record<GameKind, number>;
  roomsCreated: number;
  dailyPlayers: number;
}

export interface AdminStats {
  from: string;
  to: string;
  days: AdminStatsDay[];
  totals: Omit<AdminStatsDay, 'date'>;
  topReferrers: { host: string; count: number }[];
  topPaths: { path: string; count: number }[];
  live: { sockets: number; rooms: number; gamesInProgress: number };
}

export interface AdminDailyRow {
  date: string;
  settings: PublicSettings;
  overridden: boolean;
  players: number;
  best: number | null;
}

export interface AdminDailyOverride {
  settings: PublicSettings;
  /** Required when the date already has games. */
  force?: boolean;
}

export interface AdminLeaderboardEntry extends LeaderboardEntry {
  gameId: string;
  hidden: boolean;
  banned: boolean;
  finishedAt: number;
}

export interface AdminPlayer extends PlayerView {
  lastSeenAt: number;
  games: number;
}

export interface AdminRoom {
  code: string;
  type: RoomType;
  phase: RoomPhase;
  players: { id: string; nickname: string; connected: boolean }[];
  createdAt: number;
  lastActivityAt: number;
}

export interface AdminAuditEntry {
  at: number;
  action: string;
  target: string;
  details?: string;
}

// --- Admin extensions (stage 3 admin agent): request/response shapes of every /api/<ADMIN_PATH>/* route. ---------------------

/** GET /api/<ADMIN_PATH>/session and POST /api/<ADMIN_PATH>/login → 200. */
export interface AdminSession {
  /** Epoch ms when the session cookie expires (12 h after login). */
  expiresAt: number;
}

/** GET /api/<ADMIN_PATH>/daily?from&to → rows newest first. Extends {@link AdminDailyRow}. */
export interface AdminDailyRowEx extends AdminDailyRow {
  /** Challenge code (`daily-YYYY-MM-DD`). */
  code: string;
  /** The day's challenge row exists (created on the first play, or by an override). */
  exists: boolean;
  /** All games of the day (started or finished) — the `force` rule applies when > 0. `players` = finished, visible. */
  games: number;
  /** Today (UTC) and past days are 'past'|'today'; later ones 'future'. */
  when: 'past' | 'today' | 'future';
}

export interface AdminDailyList {
  today: string;
  days: AdminDailyRowEx[];
}

/** One challenge with its full (moderation) leaderboard: GET /api/<ADMIN_PATH>/challenges/:code, GET /api/<ADMIN_PATH>/daily/:date. */
export interface AdminChallengeView {
  code: string;
  kind: ChallengeKind;
  settings: PublicSettings;
  createdBy: { id: string; nickname: string } | null;
  createdAt: number;
  date: string | null;
  roomCode: string | null;
  status: 'open' | 'running';
  /** Games of the challenge, started or finished. */
  games: number;
  /** Unfinished games. */
  inProgress: number;
  /**
   * Every finished game, including hidden ones and banned players, in leaderboard order. `rank` is the public rank
   * (visible entries only); hidden/banned entries have rank 0.
   */
  entries: AdminLeaderboardEntry[];
}

export interface AdminDailyDetail {
  row: AdminDailyRowEx;
  /** null when the day's challenge does not exist yet. */
  challenge: AdminChallengeView | null;
}

/** POST /api/<ADMIN_PATH>/games/:id/hide */
export interface AdminHideRequest {
  hidden: boolean;
}

/** GET /api/<ADMIN_PATH>/players?q=&limit= (q matches nickname substring, case-insensitive, or an id prefix). */
export interface AdminPlayerList {
  players: AdminPlayer[];
  /** Matches in total (players is capped by limit). */
  total: number;
}

export interface AdminPlayerGame {
  id: string;
  challengeCode: string;
  kind: GameKind;
  roomCode: string | null;
  createdAt: number;
  finishedAt: number | null;
  total: number;
  timeMs: number;
  hidden: boolean;
  /** Rounds played (finished). */
  rounds: number;
}

export interface AdminPlayerDetail {
  player: AdminPlayer;
  games: AdminPlayerGame[];
  bans: { action: 'ban' | 'unban'; reason: string | null; at: number }[];
}

/** POST /api/<ADMIN_PATH>/players/:id/ban */
export interface AdminBanRequest {
  banned: boolean;
  reason?: string;
}

/** GET /api/<ADMIN_PATH>/rooms. `available` is false when the rooms module is not running (no live data). */
export interface AdminRoomsView {
  available: boolean;
  rooms: AdminRoom[];
}

export interface AdminBlockedWord {
  word: string;
  addedAt: number;
}

/** GET/POST/DELETE /api/<ADMIN_PATH>/blocklist… */
export interface AdminBlocklist {
  words: AdminBlockedWord[];
}

/** POST /api/<ADMIN_PATH>/blocklist */
export interface AdminBlockWordRequest {
  word: string;
}

/** GET /api/<ADMIN_PATH>/blocklist/check?nickname= → why a nickname would be refused. */
export interface AdminNicknameCheck {
  nickname: string;
  /** 'ok' | 'format' (length/charset) | 'blocked' (built-in roots or the blocklist). */
  result: 'ok' | 'format' | 'blocked';
  /** The matching root or blocklist word when blocked. */
  match: string | null;
}

/** GET /api/<ADMIN_PATH>/audit?limit=&before= → newest first; pass `next` as `before` for the next page. */
export interface AdminAuditPage {
  entries: AdminAuditEntry[];
  next: number | null;
}
