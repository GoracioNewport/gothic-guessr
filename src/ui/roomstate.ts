/**
 * Pure client-side room logic (SPEC §10.6, §10.7): the reducer that folds server messages into the room state the
 * screens render, plus the small calculations the room screens need (player colours, HP bar ratios, round tables,
 * standings with ranks, the duel outcome, whether the host may start). No DOM, no i18n; tested in
 * tests/roomstate.test.ts.
 */
import type {
  ApiErrorCode,
  DuelState,
  PanoNode,
  RoomPlayer,
  RoomRoundResult,
  RoomView,
  ServerMessage,
  Standing,
  WorldGuess,
} from '../../shared/api';

/** Duel starting health (server/core/duel.ts DUEL_START_HP). */
export const DUEL_START_HP = 6000;
/** The duel's round cap (server/core/settings.ts DUEL_MAX_ROUNDS). */
export const DUEL_ROUND_CAP = 30;
/** Players a normal room (party) holds (server/core/party.ts PARTY_CAPACITY). */
export const PARTY_CAPACITY = 16;

type RoundResultMsg = Extract<ServerMessage, { t: 'roundResult' }>;
type GameOverMsg = Extract<ServerMessage, { t: 'gameOver' }>;

export interface RoomRound {
  n: number;
  node: PanoNode;
  deadline: number | null;
  startedAt: number;
  duel?: DuelState;
}

/** Everything the room page knows, rebuilt from server messages only. */
export interface RoomState {
  /** Latest room view (null before the first `room`). */
  room: RoomView | null;
  /** This player's game in the running room game. */
  gameId: string | null;
  /** Challenge of the running or last game. */
  challengeCode: string | null;
  /** The open round, or the last one during its result. */
  round: RoomRound | null;
  /** Players who guessed in `round`. */
  guessed: string[];
  /** Duel: deadline after the first guess (also copied into `round.deadline`). */
  countdown: number | null;
  /** Result of `round` once it closed. */
  result: RoundResultMsg | null;
  /** HP before the last result (for the damage animation). */
  hpBefore: Record<string, number> | null;
  /** Last finished game. */
  gameOver: GameOverMsg | null;
  /** Removed by the host. */
  kicked: boolean;
  /** Last error received. */
  error: ApiErrorCode | null;
  /** Counter bumped on every error (so the same code twice is two events). */
  errorSeq: number;
}

export function initialRoomState(): RoomState {
  return {
    room: null,
    gameId: null,
    challengeCode: null,
    round: null,
    guessed: [],
    countdown: null,
    result: null,
    hpBefore: null,
    gameOver: null,
    kicked: false,
    error: null,
    errorSeq: 0,
  };
}

/** What the page should show for `state`. */
export type RoomScreen = 'loading' | 'lobby' | 'round' | 'result' | 'over' | 'kicked';

export function roomScreen(state: RoomState): RoomScreen {
  if (state.kicked) return 'kicked';
  if (!state.room) return 'loading';
  const phase = state.room.phase;
  if (state.gameId) {
    if (state.result && state.round && state.result.n === state.round.n) return 'result';
    if (state.round) return 'round';
  }
  // A game runs but its state has not arrived yet (reconnect: `room` comes before `started` and `round`).
  if (phase === 'round' || phase === 'result') return 'loading';
  if (phase === 'over' && state.gameOver) return 'over';
  return 'lobby';
}

/** Fold one server message into the state. Unknown or stale messages leave it unchanged. */
export function reduceRoom(state: RoomState, msg: ServerMessage): RoomState {
  switch (msg.t) {
    case 'room': {
      const room = msg.room;
      const next: RoomState = { ...state, room };
      if (room.challengeCode) next.challengeCode = room.challengeCode;
      // Back in the lobby (or over) with no game of ours: the running game is gone.
      if ((room.phase === 'lobby' || room.phase === 'over') && room.myGameId === null) {
        next.gameId = null;
        next.round = null;
        next.guessed = [];
        next.countdown = null;
        next.result = null;
        next.hpBefore = null;
      }
      return next;
    }
    case 'started':
      if (state.gameId === msg.gameId) return { ...state, challengeCode: msg.challengeCode };
      return {
        ...state,
        gameId: msg.gameId,
        challengeCode: msg.challengeCode,
        round: null,
        guessed: [],
        countdown: null,
        result: null,
        hpBefore: null,
        gameOver: null,
      };
    case 'round': {
      if (state.round && state.round.n === msg.n && !state.result) {
        // The same round again (reconnect sync): keep the guessed ticks, refresh the rest.
        return { ...state, round: { ...roundOf(msg), deadline: state.countdown ?? msg.deadline } };
      }
      return { ...state, round: roundOf(msg), guessed: [], countdown: null, result: null };
    }
    case 'guessed':
      if (!state.round || state.result || state.guessed.includes(msg.playerId)) return state;
      return { ...state, guessed: [...state.guessed, msg.playerId] };
    case 'countdown':
      if (!state.round || state.result) return state;
      return { ...state, countdown: msg.deadline, round: { ...state.round, deadline: msg.deadline } };
    case 'roundResult': {
      if (state.result && state.result.n === msg.n) return { ...state, result: msg };
      const hpBefore = state.round?.duel?.hp ?? (state.result?.duel ? state.result.duel.hp : null);
      // A result for a round we never saw (reconnect during the result phase): synthesise the round number.
      const round: RoomRound | null = state.round && state.round.n === msg.n ? state.round : state.round ? { ...state.round, n: msg.n } : null;
      return {
        ...state,
        round: round ?? { n: msg.n, node: { key: '', links: [] }, deadline: null, startedAt: 0 },
        result: msg,
        hpBefore: hpBefore ? { ...hpBefore } : null,
        countdown: null,
      };
    }
    case 'gameOver':
      return {
        ...state,
        gameOver: msg,
        challengeCode: msg.challengeCode,
        gameId: null,
        round: null,
        guessed: [],
        countdown: null,
        result: null,
      };
    case 'kicked':
      return { ...state, kicked: true };
    case 'error':
      return { ...state, error: msg.error, errorSeq: state.errorSeq + 1 };
    case 'pong':
      return state;
  }
}

function roundOf(msg: Extract<ServerMessage, { t: 'round' }>): RoomRound {
  const r: RoomRound = { n: msg.n, node: msg.node, deadline: msg.deadline, startedAt: msg.startedAt };
  if (msg.duel) r.duel = { hp: { ...msg.duel.hp }, multiplier: msg.duel.multiplier };
  return r;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** Errors after which this tab cannot stay in the room. */
const FATAL: readonly ApiErrorCode[] = ['not_found', 'room_closed', 'room_full', 'room_started', 'forbidden', 'banned', 'auth'];

/**
 * How the page reacts to `error`: `fatal` ends the room page with a message; `replaced` means another tab of this
 * player took the room over (`conflict` that is not the answer to our own `start`); `toast` just shows it.
 */
export function errorSeverity(error: ApiErrorCode, ctx: { awaitingStart: boolean; joined: boolean }): 'fatal' | 'replaced' | 'toast' {
  if (error === 'conflict') return ctx.awaitingStart ? 'toast' : 'replaced';
  // Once joined, `not_found` answers an action sent while detached and `forbidden` a refused kick (duel): not fatal.
  if ((error === 'not_found' || error === 'forbidden') && ctx.joined) return 'toast';
  return FATAL.includes(error) ? 'fatal' : 'toast';
}

// ---------------------------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------------------------

/**
 * Sixteen marker colours, distinct on the painted maps (no blue: the player's own pin; no gold: the answer).
 * Picked by the player's position in the room, so everyone sees the same colour for the same player.
 */
export const PLAYER_COLORS: readonly string[] = [
  '#e6194b', '#3cb44b', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe',
  '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000', '#aaffc3', '#808000', '#ffd8b1',
];

/** playerId → colour for the room's players (room order; ids not in the room get the following colours). */
export function playerColors(players: readonly Pick<RoomPlayer, 'id'>[], extraIds: readonly string[] = []): Map<string, string> {
  const map = new Map<string, string>();
  for (const id of [...players.map((p) => p.id), ...extraIds]) {
    if (!map.has(id)) map.set(id, PLAYER_COLORS[map.size % PLAYER_COLORS.length]!);
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// Duel health
// ---------------------------------------------------------------------------------------------

/** Fill ratio of an HP bar in [0, 1]. */
export function hpRatio(hp: number, max = DUEL_START_HP): number {
  if (!(max > 0) || !Number.isFinite(hp)) return 0;
  return Math.min(1, Math.max(0, hp / max));
}

/** CSS width of the HP bar fill, e.g. `"37.50%"`. */
export function hpWidth(hp: number, max = DUEL_START_HP): string {
  return `${(hpRatio(hp, max) * 100).toFixed(2)}%`;
}

/** The two duel players with their HP in a stable order: this player first, then the opponent. */
export function duelSides(
  hp: Record<string, number>,
  me: string | null,
  names: ReadonlyMap<string, string>,
): { id: string; name: string; hp: number; me: boolean }[] {
  const ids = Object.keys(hp).sort((a, b) => (a === me ? -1 : b === me ? 1 : 0));
  return ids.map((id) => ({ id, name: names.get(id) ?? '?', hp: hp[id] ?? 0, me: id === me }));
}

// ---------------------------------------------------------------------------------------------
// Round table and standings
// ---------------------------------------------------------------------------------------------

export interface RoundRow {
  rank: number;
  playerId: string;
  name: string;
  me: boolean;
  guess: WorldGuess | null;
  distanceM: number | null;
  /** The guess landed on another world than the answer. */
  wrongWorld: boolean;
  score: number;
  timeMs: number;
  /** Duel: HP lost this round. */
  damage?: number;
  /** Duel: HP after the round. */
  hp?: number;
}

/** Shared ranks: equal keys get the rank of the first of them (1, 2, 2, 4). `items` must already be sorted. */
export function sharedRanks<T>(items: readonly T[], same: (a: T, b: T) => boolean): number[] {
  const ranks: number[] = [];
  items.forEach((item, i) => {
    ranks.push(i > 0 && same(items[i - 1]!, item) ? ranks[i - 1]! : i + 1);
  });
  return ranks;
}

/** The round table: every result, best score first (faster first on equal scores). */
export function roundRows(msg: RoundResultMsg, me: string | null, names: ReadonlyMap<string, string>): RoundRow[] {
  const sorted = [...msg.results].sort((a, b) => b.score - a.score || a.timeMs - b.timeMs);
  const ranks = sharedRanks(sorted, (a, b) => a.score === b.score && a.timeMs === b.timeMs);
  return sorted.map((r: RoomRoundResult, i) => {
    const row: RoundRow = {
      rank: ranks[i]!,
      playerId: r.playerId,
      name: names.get(r.playerId) ?? '?',
      me: r.playerId === me,
      guess: r.guess,
      distanceM: r.distanceM,
      wrongWorld: r.guess !== null && r.guess.world !== msg.answer.world,
      score: r.score,
      timeMs: r.timeMs,
    };
    if (msg.duel) {
      row.damage = msg.duel.damage[r.playerId] ?? 0;
      row.hp = msg.duel.hp[r.playerId];
    }
    return row;
  });
}

export interface StandingRow extends Standing {
  rank: number;
  me: boolean;
  winner: boolean;
}

/** Final standings with shared ranks (server order is kept: it already puts the duel winner first). */
export function standingRows(standings: readonly Standing[], me: string | null, winner: string | null | undefined): StandingRow[] {
  const duel = winner !== undefined;
  const ranks = sharedRanks(standings, (a, b) =>
    duel ? a.playerId !== winner && b.playerId !== winner && (a.hp ?? 0) === (b.hp ?? 0) && a.total === b.total : a.total === b.total && a.timeMs === b.timeMs,
  );
  return standings.map((s, i) => ({
    ...s,
    rank: duel && winner === null ? 1 : ranks[i]!,
    me: s.playerId === me,
    winner: duel ? s.playerId === winner : i === 0 && standings.length > 1 && ranks[1] !== 1,
  }));
}

// ---------------------------------------------------------------------------------------------
// Duel outcome
// ---------------------------------------------------------------------------------------------

export type DuelOutcome =
  | { kind: 'draw' }
  | { kind: 'win' | 'lose' | 'watch'; winner: string; loser: string | null; reason: 'ko' | 'forfeit' | 'rounds' };

/**
 * How a duel ended, as this player sees it. The server's `reason` decides (`cap` reads as the round cap,
 * `rounds`). Without it (a game cut short by a server error, or an older server) it is inferred: KO = the loser has
 * 0 HP, a forfeit when the loser left or is disconnected (the room after the game says so), else the round cap.
 */
export function duelOutcome(over: GameOverMsg, me: string | null, room: RoomView | null): DuelOutcome | null {
  if (over.winner === undefined) return null;
  if (over.winner === null) return { kind: 'draw' };
  const winner = over.winner;
  const loserRow = over.standings.find((s) => s.playerId !== winner) ?? null;
  const loser = loserRow?.playerId ?? null;
  let reason: 'ko' | 'forfeit' | 'rounds' = 'rounds';
  if (over.reason !== undefined) reason = over.reason === 'cap' ? 'rounds' : over.reason;
  else if (loserRow && (loserRow.hp ?? 0) <= 0) reason = 'ko';
  else if (loser !== null && room) {
    const p = room.players.find((x) => x.id === loser);
    if (!p || !p.connected) reason = 'forfeit';
  }
  const kind = me === winner ? 'win' : me === loser ? 'lose' : 'watch';
  return { kind, winner, loser, reason };
}

// ---------------------------------------------------------------------------------------------
// Lobby rules
// ---------------------------------------------------------------------------------------------

export type StartBlock = 'notHost' | 'needTwo' | 'noPlayers' | 'started';

/** Whether `me` may press Start now, mirroring the server's rule (connected players: party ≥ 1, duel exactly 2). */
export function startBlock(room: RoomView, me: string | null): StartBlock | null {
  const host = room.players.find((p) => p.host);
  if (!me || host?.id !== me) return 'notHost';
  if (room.phase !== 'lobby' && room.phase !== 'over') return 'started';
  const connected = room.players.filter((p) => p.connected).length;
  if (room.type === 'duel') return connected === 2 ? null : 'needTwo';
  return connected >= 1 ? null : 'noPlayers';
}

/** True when this player is the room's host. */
export function isHost(room: RoomView | null, me: string | null): boolean {
  return !!room && !!me && room.players.some((p) => p.id === me && p.host);
}

/** playerId → nickname from the room plus (for players who already left) the standings / defaults. */
export function nicknames(room: RoomView | null, standings: readonly Standing[] = []): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of standings) map.set(s.playerId, s.nickname);
  for (const p of room?.players ?? []) map.set(p.id, p.nickname);
  return map;
}

/** Whole seconds left until `at` (server epoch ms), never negative. */
export function secondsUntil(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 1000));
}
