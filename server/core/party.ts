/**
 * Room state machine (SPEC §10.6): the lobby, the party rules, and the round flow shared with duels (the duel's HP,
 * countdown and forfeit rules live in core/duel.ts and are plugged in through {@link DuelMatch}). Pure: no I/O, no
 * timers, an injected clock. The hub (server/rooms/) feeds it events and carries out the effects it returns.
 *
 * ─── Events in ({@link RoomEvent}) ────────────────────────────────────────────────────────────────────────────────────
 *   join {playerId, nickname}        a socket joins (new member, or a member reconnecting)
 *   leave / disconnect {playerId}     explicit leave / the socket dropped
 *   settings {playerId, settings, roomType?}   host, lobby only
 *   kick {playerId, target}           host
 *   start / next {playerId}           host
 *   endRound {playerId}               host, party round: everyone left gets {@link END_ROUND_COUNTDOWN_MS}
 *   guess {playerId, n, challengeCode}   a round outcome was recorded through REST (GameService `guess` event)
 *   tick                              timers: deadlines, auto-advance, duel forfeit, host handover, idle expiry
 *   close {reason}                    admin / shutdown
 *   gamesCreated | roundOpened | roundClosed | finished | callFailed   results of the service calls below
 *
 * ─── Effects out ({@link RoomEffect}) ─────────────────────────────────────────────────────────────────────────────────
 *   send {to, msg}      a ServerMessage to one player (the hub drops it when the player has no socket)
 *   attach / detach     bind the joining socket to the player / unbind the player's socket from this room
 *   call {call}         a GameService room-API call (core/games.ts); the hub runs it and feeds the result event back
 *   closed              the room is gone: the registry forgets it
 * The hub must process one event at a time per room, including the result events of the calls it returns.
 * {@link RoomMachine.nextWakeAt} says when the next `tick` is due.
 *
 * ─── Rules ────────────────────────────────────────────────────────────────────────────────────────────────────────────
 *   - Capacity 16 (party) / 2 (duel). Joining after the start → `room_started`; a full lobby → `room_full`.
 *   - `start` drops members whose socket is gone; party needs ≥ 1 player, duel exactly 2 (else `conflict`).
 *   - Every player gets a game row in the room's challenge; the room opens round n of all games at the same instant.
 *   - Party: a round ends when every connected player guessed (or every player did) or at deadline + 2 s grace; the
 *     result phase advances after 15 s or on the host's `next`. Disconnected players score 0 for missed rounds and
 *     may reconnect; `leave` during a game keeps the player in the standings (removed after the game). The host's
 *     `endRound` moves the deadline to now + {@link END_ROUND_COUNTDOWN_MS} (never later) and sends `countdown`, so
 *     an untimed round cannot stall on an idle player: clients submit a placed marker before it, the rest time out.
 *   - Duel: see core/duel.ts. `leave` or `kick` cannot be used to end a duel early: leave forfeits, kick is refused.
 *   - Host: on leave passes to the earliest remaining member (a connected one first), and to the earliest connected
 *     member once the host has been disconnected for {@link HOST_HANDOVER_MS}.
 *   - After the last round (or a duel KO/forfeit) the next advance finishes the challenge and sends `gameOver`; the
 *     room then sits in phase `over`, which accepts every lobby action (settings, join, kick, start).
 *   - The room closes after {@link ROOM_IDLE_MS} without player activity; a running game is finished first.
 */
import type {
  AdminRoom,
  ApiErrorCode,
  PanoNode,
  PublicSettings,
  RoomPhase,
  RoomPlayer,
  RoomRoundResult,
  RoomType,
  RoomView,
  ServerMessage,
  Standing,
  WorldGuess,
} from '../../shared/api';
import { END_ROUND_COUNTDOWN_MS } from '../../shared/api';
import type { GameOverReason } from '../../shared/api';
import {
  DuelMatch,
  DUEL_RESULT_MS,
  duelCountdownDeadline,
  duelForfeiter,
  duelForfeitWakeAt,
  duelMultiplier,
  duelRoundDeadline,
} from './duel';
import { ApiFailure } from './errors';
import { DEADLINE_GRACE_MS } from './settings';

export const PARTY_CAPACITY = 16;
export const DUEL_CAPACITY = 2;
/** Party result phase length before the automatic advance. */
export const PARTY_RESULT_MS = 15_000;
/** A disconnected host keeps the role this long (a page reload must not cost it). */
export const HOST_HANDOVER_MS = 30_000;
/** Rooms expire after this long without player activity. */
export const ROOM_IDLE_MS = 30 * 60_000;

export function roomCapacity(type: RoomType): number {
  return type === 'duel' ? DUEL_CAPACITY : PARTY_CAPACITY;
}

// ---------------------------------------------------------------------------------------------------------------------
// Events and effects
// ---------------------------------------------------------------------------------------------------------------------

/** Service calls the hub carries out (GameService room API, core/games.ts). */
export type RoomCall =
  | { op: 'createGames'; type: RoomType; settings: PublicSettings; hostId: string; playerIds: string[] }
  | { op: 'openRound'; challengeCode: string; n: number; startedAt: number; deadline: number | null }
  | { op: 'setDeadline'; challengeCode: string; n: number; deadline: number | null }
  | { op: 'closeRound'; challengeCode: string; n: number }
  | { op: 'finish'; challengeCode: string; roundsPlayed: number };

export type RoomEvent =
  | { type: 'join'; playerId: string; nickname: string }
  | { type: 'leave'; playerId: string }
  | { type: 'disconnect'; playerId: string }
  | { type: 'settings'; playerId: string; settings: unknown; roomType?: unknown }
  | { type: 'kick'; playerId: string; target: string }
  | { type: 'start'; playerId: string }
  | { type: 'next'; playerId: string }
  | { type: 'endRound'; playerId: string }
  | { type: 'guess'; playerId: string; n: number; challengeCode: string }
  | { type: 'tick' }
  | { type: 'close'; reason: 'admin' | 'shutdown' }
  // Call results
  | { type: 'gamesCreated'; challengeCode: string; games: Record<string, string>; rounds: number; settings: PublicSettings }
  | { type: 'roundOpened'; n: number; node: PanoNode }
  | { type: 'roundClosed'; n: number; answer: WorldGuess; results: RoomRoundResult[] }
  | { type: 'finished' }
  | { type: 'callFailed'; op: RoomCall['op']; error: ApiErrorCode };

export type RoomEffect =
  | { type: 'send'; to: string; msg: ServerMessage }
  | { type: 'attach'; playerId: string }
  | { type: 'detach'; playerId: string }
  | { type: 'call'; call: RoomCall }
  | { type: 'closed'; reason: 'empty' | 'expired' | 'admin' | 'shutdown' };

export interface RoomMachineDeps {
  /** Epoch ms. */
  clock: () => number;
  /** Validate client settings for a room type (core/settings.ts `parseSettings` over the loaded worlds); throws ApiFailure. */
  parseSettings: (raw: unknown, type: RoomType) => PublicSettings;
}

export interface RoomInit {
  code: string;
  type: RoomType;
  /** Already validated. */
  settings: PublicSettings;
  hostId: string;
  hostNickname: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------------------------

interface Member {
  id: string;
  nickname: string;
  /** Join order (host handover picks the lowest). */
  seq: number;
  connected: boolean;
  disconnectedAt: number | null;
  /** Left or was kicked during a game: stays in its standings, removed when it ends. */
  gone: boolean;
}

type Phase = 'lobby' | 'starting' | 'round' | 'result' | 'over';

interface Running {
  challengeCode: string;
  /** playerId → gameId, in start order. */
  games: Map<string, string>;
  nicknames: Map<string, string>;
  /** Rounds available (party: settings.rounds; duel: the cap). */
  rounds: number;
  settings: PublicSettings;
  /** Current (or last) round, 0 before the first opens. */
  n: number;
  node: PanoNode | null;
  startedAt: number;
  deadline: number | null;
  /** Duel: the countdown after the first guess is running. */
  countdown: boolean;
  guessed: Set<string>;
  nextAt: number | null;
  lastResult: Extract<ServerMessage, { t: 'roundResult' }> | null;
  totals: Map<string, { total: number; timeMs: number }>;
  duel: DuelMatch | null;
  /** Decided: finish on the next advance (or at once for a forfeit). `reason` is absent after a failed call. */
  end: { winner: string | null; forfeit: boolean; reason?: GameOverReason } | null;
  /** A call is in flight. */
  busy: RoomCall['op'] | null;
}

interface LastGame {
  challengeCode: string;
  standings: Standing[];
  winner: string | null | undefined;
  reason: GameOverReason | undefined;
}

export class RoomMachine {
  readonly code: string;
  readonly createdAt: number;
  private roomType: RoomType;
  private roomSettings: PublicSettings;
  private phase: Phase = 'lobby';
  private readonly members: Member[] = [];
  private hostId: string;
  private seq = 0;
  private readonly kicked = new Set<string>();
  private game: Running | null = null;
  private last: LastGame | null = null;
  private lastActivity: number;
  private isClosed = false;
  private readonly clock: () => number;
  private readonly parse: RoomMachineDeps['parseSettings'];

  constructor(init: RoomInit, deps: RoomMachineDeps) {
    this.clock = deps.clock;
    this.parse = deps.parseSettings;
    this.code = init.code;
    this.roomType = init.type;
    this.roomSettings = init.settings;
    this.hostId = init.hostId;
    const now = this.clock();
    this.createdAt = now;
    this.lastActivity = now;
    // The creator is a member from the start; the socket joins later.
    this.members.push({ id: init.hostId, nickname: init.hostNickname, seq: this.seq++, connected: false, disconnectedAt: now, gone: false });
  }

  get type(): RoomType {
    return this.roomType;
  }

  get settings(): PublicSettings {
    return this.roomSettings;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  get lastActivityAt(): number {
    return this.lastActivity;
  }

  get host(): string {
    return this.hostId;
  }

  /** Public phase. */
  get publicPhase(): RoomPhase {
    return this.phase === 'starting' ? 'lobby' : this.phase;
  }

  /** A room game is in progress (challenge rows exist and are not finished yet). */
  get gameRunning(): boolean {
    return this.game !== null;
  }

  memberIds(): string[] {
    return this.members.map((m) => m.id);
  }

  isMember(playerId: string): boolean {
    return this.member(playerId) !== undefined;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------------------------------------------------

  view(playerId: string | null): RoomView {
    const g = this.game;
    const players: RoomPlayer[] = this.members.map((m) => {
      const p: RoomPlayer = {
        id: m.id,
        nickname: m.nickname,
        host: m.id === this.hostId,
        connected: m.connected,
        guessed: g !== null && this.phase === 'round' && g.guessed.has(m.id),
        total: this.totalOf(m.id),
      };
      const hp = this.hpOf(m.id);
      if (hp !== undefined) p.hp = hp;
      return p;
    });
    return {
      code: this.code,
      type: this.roomType,
      phase: this.publicPhase,
      settings: { ...this.roomSettings, worlds: [...this.roomSettings.worlds] },
      players,
      capacity: roomCapacity(this.roomType),
      round: g && (this.phase === 'round' || this.phase === 'result') ? g.n : 0,
      challengeCode: g?.challengeCode ?? this.last?.challengeCode ?? null,
      myGameId: g && playerId !== null ? (g.games.get(playerId) ?? null) : null,
    };
  }

  adminView(): AdminRoom {
    return {
      code: this.code,
      type: this.roomType,
      phase: this.publicPhase,
      players: this.members.map((m) => ({ id: m.id, nickname: m.nickname, connected: m.connected })),
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivity,
    };
  }

  /** When the next `tick` is due (epoch ms), or null. */
  nextWakeAt(): number | null {
    if (this.isClosed) return null;
    const times: number[] = [this.lastActivity + ROOM_IDLE_MS];
    const g = this.game;
    if (g && g.busy === null) {
      if (this.phase === 'round' && g.deadline !== null) times.push(g.deadline + DEADLINE_GRACE_MS);
      // The result phase holds while nobody is connected (see onTick), so no wake-up is due then.
      if (this.phase === 'result' && g.nextAt !== null && this.members.some((m) => m.connected)) times.push(g.nextAt);
      if (g.duel) {
        const at = duelForfeitWakeAt(this.members.filter((m) => g.games.has(m.id)));
        if (at !== null) times.push(at);
      }
    }
    const host = this.member(this.hostId);
    if (host && !host.connected && host.disconnectedAt !== null && this.members.some((m) => m.connected)) {
      times.push(host.disconnectedAt + HOST_HANDOVER_MS);
    }
    return Math.min(...times);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Event dispatch
  // -------------------------------------------------------------------------------------------------------------------

  handle(ev: RoomEvent): RoomEffect[] {
    const out: RoomEffect[] = [];
    if (this.isClosed) {
      if (ev.type === 'join') out.push(this.errorTo(ev.playerId, 'room_closed'));
      return out;
    }
    switch (ev.type) {
      case 'join':
        this.onJoin(ev.playerId, ev.nickname, out);
        break;
      case 'leave':
        this.onLeave(ev.playerId, out);
        break;
      case 'disconnect':
        this.onDisconnect(ev.playerId, out);
        break;
      case 'settings':
        this.onSettings(ev.playerId, ev.settings, ev.roomType, out);
        break;
      case 'kick':
        this.onKick(ev.playerId, ev.target, out);
        break;
      case 'start':
        this.onStart(ev.playerId, out);
        break;
      case 'next':
        this.onNext(ev.playerId, out);
        break;
      case 'endRound':
        this.onEndRound(ev.playerId, out);
        break;
      case 'guess':
        this.onGuess(ev.playerId, ev.n, ev.challengeCode, out);
        break;
      case 'tick':
        this.onTick(out);
        break;
      case 'close':
        this.closeRoom(ev.reason, out);
        break;
      case 'gamesCreated':
        this.onGamesCreated(ev, out);
        break;
      case 'roundOpened':
        this.onRoundOpened(ev.n, ev.node, out);
        break;
      case 'roundClosed':
        this.onRoundClosed(ev.n, ev.answer, ev.results, out);
        break;
      case 'finished':
        this.onFinished(out);
        break;
      case 'callFailed':
        this.onCallFailed(ev.op, ev.error, out);
        break;
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Lobby
  // -------------------------------------------------------------------------------------------------------------------

  private onJoin(playerId: string, nickname: string, out: RoomEffect[]): void {
    if (this.kicked.has(playerId)) {
      out.push(this.errorTo(playerId, 'forbidden'));
      return;
    }
    const now = this.clock();
    let m = this.member(playerId);
    if (!m) {
      if (this.phase !== 'lobby' && this.phase !== 'over') {
        out.push(this.errorTo(playerId, 'room_started'));
        return;
      }
      if (this.members.length >= roomCapacity(this.roomType)) {
        out.push(this.errorTo(playerId, 'room_full'));
        return;
      }
      m = { id: playerId, nickname, seq: this.seq++, connected: true, disconnectedAt: null, gone: false };
      this.members.push(m);
    } else {
      m.nickname = nickname;
      m.connected = true;
      m.disconnectedAt = null;
      m.gone = false;
      this.game?.nicknames.set(playerId, nickname);
    }
    this.touch(now);
    out.push({ type: 'attach', playerId });
    this.broadcastRoom(out);
    this.sync(playerId, out);
  }

  private onLeave(playerId: string, out: RoomEffect[]): void {
    const m = this.member(playerId);
    if (!m) return;
    const now = this.clock();
    this.touch(now);
    out.push({ type: 'detach', playerId });
    const g = this.game;
    if (g && g.games.has(playerId)) {
      m.connected = false;
      m.disconnectedAt = now;
      m.gone = true;
      if (playerId === this.hostId) this.passHost(false);
      if (g.duel) {
        this.forfeit(playerId, out);
      } else {
        this.checkRoundComplete(out);
      }
      this.broadcastRoom(out);
      return;
    }
    this.removeMember(playerId);
    if (this.members.length === 0) {
      this.closeRoom('empty', out);
      return;
    }
    this.broadcastRoom(out);
  }

  private onDisconnect(playerId: string, out: RoomEffect[]): void {
    const m = this.member(playerId);
    if (!m || !m.connected) return;
    m.connected = false;
    m.disconnectedAt = this.clock();
    const g = this.game;
    if (g && !g.duel) this.checkRoundComplete(out);
    this.broadcastRoom(out);
  }

  private onSettings(playerId: string, raw: unknown, rawType: unknown, out: RoomEffect[]): void {
    if (!this.requireHost(playerId, out) || !this.requireLobby(playerId, out)) return;
    const type = rawType === undefined ? this.roomType : rawType;
    if (type !== 'party' && type !== 'duel') {
      out.push(this.errorTo(playerId, 'bad_request'));
      return;
    }
    if (this.members.length > roomCapacity(type)) {
      out.push(this.errorTo(playerId, 'room_full'));
      return;
    }
    let settings: PublicSettings;
    try {
      settings = this.parse(raw, type);
    } catch (err) {
      out.push(this.errorTo(playerId, err instanceof ApiFailure ? err.code : 'bad_request'));
      return;
    }
    this.roomType = type;
    this.roomSettings = settings;
    this.touch(this.clock());
    this.broadcastRoom(out);
  }

  private onKick(playerId: string, target: string, out: RoomEffect[]): void {
    if (!this.requireHost(playerId, out)) return;
    const m = this.member(target);
    if (!m) {
      out.push(this.errorTo(playerId, 'not_found'));
      return;
    }
    if (target === this.hostId) {
      out.push(this.errorTo(playerId, 'bad_request'));
      return;
    }
    const g = this.game;
    if (g?.duel) {
      out.push(this.errorTo(playerId, 'forbidden'));
      return;
    }
    this.touch(this.clock());
    this.kicked.add(target);
    out.push({ type: 'send', to: target, msg: { t: 'kicked' } }, { type: 'detach', playerId: target });
    if (g && g.games.has(target)) {
      m.connected = false;
      m.disconnectedAt = this.clock();
      m.gone = true;
      this.checkRoundComplete(out);
    } else {
      this.removeMember(target);
    }
    this.broadcastRoom(out);
  }

  private onStart(playerId: string, out: RoomEffect[]): void {
    if (!this.requireHost(playerId, out) || !this.requireLobby(playerId, out)) return;
    const ready = this.members.filter((m) => m.connected);
    const ok = this.roomType === 'duel' ? ready.length === DUEL_CAPACITY : ready.length >= 1;
    if (!ok || !ready.some((m) => m.id === this.hostId)) {
      out.push(this.errorTo(playerId, 'conflict'));
      return;
    }
    // Members whose socket is gone do not take part (and leave the room).
    for (const m of [...this.members]) if (!m.connected) this.removeMember(m.id);
    this.touch(this.clock());
    this.phase = 'starting';
    this.last = null;
    out.push({
      type: 'call',
      call: {
        op: 'createGames',
        type: this.roomType,
        settings: this.roomSettings,
        hostId: this.hostId,
        playerIds: this.members.map((m) => m.id),
      },
    });
  }

  private onNext(playerId: string, out: RoomEffect[]): void {
    if (!this.requireHost(playerId, out)) return;
    const g = this.game;
    // A late or double `next` is harmless: ignore it outside the result phase.
    if (!g || this.phase !== 'result' || g.busy !== null) return;
    this.touch(this.clock());
    this.advance(out);
  }

  /**
   * Party: the host ends the round for everyone. The deadline moves to now + {@link END_ROUND_COUNTDOWN_MS} (an
   * earlier deadline stays) and everyone gets `countdown`; the round then closes like a timed one (everyone connected
   * guessed, or deadline + grace), so the players still guessing can have their placed markers submitted.
   */
  private onEndRound(playerId: string, out: RoomEffect[]): void {
    if (!this.requireHost(playerId, out)) return;
    const g = this.game;
    if (!g || this.phase !== 'round' || g.busy !== null) {
      out.push(this.errorTo(playerId, 'round_over'));
      return;
    }
    if (g.duel) {
      out.push(this.errorTo(playerId, 'forbidden'));
      return;
    }
    const now = this.clock();
    this.touch(now);
    const deadline = g.deadline === null ? now + END_ROUND_COUNTDOWN_MS : Math.min(g.deadline, now + END_ROUND_COUNTDOWN_MS);
    if (g.countdown && deadline === g.deadline) return; // already ending
    g.countdown = true;
    if (deadline !== g.deadline) {
      g.deadline = deadline;
      out.push({ type: 'call', call: { op: 'setDeadline', challengeCode: g.challengeCode, n: g.n, deadline } });
    }
    for (const id of this.memberIds()) out.push({ type: 'send', to: id, msg: { t: 'countdown', deadline } });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Game flow
  // -------------------------------------------------------------------------------------------------------------------

  private onGamesCreated(ev: Extract<RoomEvent, { type: 'gamesCreated' }>, out: RoomEffect[]): void {
    if (this.phase !== 'starting') return;
    const ids = Object.keys(ev.games);
    const nicknames = new Map(this.members.map((m) => [m.id, m.nickname] as const));
    const g: Running = {
      challengeCode: ev.challengeCode,
      games: new Map(this.members.filter((m) => ev.games[m.id]).map((m) => [m.id, ev.games[m.id]!] as const)),
      nicknames,
      rounds: ev.rounds,
      settings: ev.settings,
      n: 0,
      node: null,
      startedAt: 0,
      deadline: null,
      countdown: false,
      guessed: new Set(),
      nextAt: null,
      lastResult: null,
      totals: new Map(ids.map((id) => [id, { total: 0, timeMs: 0 }] as const)),
      duel: this.roomType === 'duel' ? new DuelMatch([...ids], ev.rounds) : null,
      end: null,
      busy: null,
    };
    this.game = g;
    for (const [playerId, gameId] of g.games) {
      out.push({ type: 'send', to: playerId, msg: { t: 'started', gameId, challengeCode: g.challengeCode } });
    }
    // Someone may have left while the games were created (impossible with a serial hub, but keep the duel fair).
    const away = this.members.find((m) => g.games.has(m.id) && m.gone);
    if (g.duel && away) {
      this.forfeit(away.id, out);
      return;
    }
    this.openRound(1, out);
  }

  private openRound(n: number, out: RoomEffect[]): void {
    const g = this.game!;
    const startedAt = this.clock();
    const tl = g.settings.timeLimit;
    const deadline = g.duel ? duelRoundDeadline(startedAt, tl) : tl > 0 ? startedAt + tl * 1000 : null;
    g.n = n;
    g.node = null;
    g.startedAt = startedAt;
    g.deadline = deadline;
    g.countdown = false;
    g.guessed = new Set();
    g.nextAt = null;
    g.busy = 'openRound';
    out.push({ type: 'call', call: { op: 'openRound', challengeCode: g.challengeCode, n, startedAt, deadline } });
  }

  private onRoundOpened(n: number, node: PanoNode, out: RoomEffect[]): void {
    const g = this.game;
    if (!g || g.busy !== 'openRound' || g.n !== n) return;
    g.busy = null;
    g.node = node;
    this.phase = 'round';
    for (const id of this.memberIds()) out.push({ type: 'send', to: id, msg: this.roundMessage(g) });
    this.broadcastRoom(out);
    if (g.end?.forfeit) this.finish(out);
  }

  private onGuess(playerId: string, n: number, challengeCode: string, out: RoomEffect[]): void {
    const g = this.game;
    if (!g || g.challengeCode !== challengeCode || !g.games.has(playerId)) return;
    if (this.phase !== 'round' || g.busy !== null || g.n !== n || g.guessed.has(playerId)) return;
    const now = this.clock();
    this.touch(now);
    g.guessed.add(playerId);
    for (const id of this.memberIds()) out.push({ type: 'send', to: id, msg: { t: 'guessed', playerId } });
    if (g.duel) {
      if (g.guessed.size >= g.games.size) {
        this.closeRound(out);
        return;
      }
      if (!g.countdown) {
        g.countdown = true;
        const deadline = duelCountdownDeadline(now, g.deadline);
        if (deadline !== g.deadline) {
          g.deadline = deadline;
          out.push({ type: 'call', call: { op: 'setDeadline', challengeCode: g.challengeCode, n: g.n, deadline } });
        }
        for (const id of this.memberIds()) out.push({ type: 'send', to: id, msg: { t: 'countdown', deadline } });
      }
      return;
    }
    this.checkRoundComplete(out);
  }

  /** Party: close the round once every connected player (or every player) has guessed. */
  private checkRoundComplete(out: RoomEffect[]): void {
    const g = this.game;
    if (!g || g.duel || this.phase !== 'round' || g.busy !== null) return;
    const players = [...g.games.keys()];
    const waiting = players.filter((id) => !g.guessed.has(id));
    if (waiting.length === 0) {
      this.closeRound(out);
      return;
    }
    const connected = players.filter((id) => this.member(id)?.connected === true);
    if (connected.length > 0 && connected.every((id) => g.guessed.has(id))) this.closeRound(out);
  }

  private closeRound(out: RoomEffect[]): void {
    const g = this.game!;
    g.busy = 'closeRound';
    out.push({ type: 'call', call: { op: 'closeRound', challengeCode: g.challengeCode, n: g.n } });
  }

  private onRoundClosed(n: number, answer: WorldGuess, results: RoomRoundResult[], out: RoomEffect[]): void {
    const g = this.game;
    if (!g || g.busy !== 'closeRound' || g.n !== n) return;
    g.busy = null;
    const now = this.clock();
    const scores: Record<string, number> = {};
    for (const r of results) {
      scores[r.playerId] = r.score;
      const t = g.totals.get(r.playerId);
      if (t) {
        t.total += r.score;
        t.timeMs += r.timeMs;
      }
    }
    const msg: Extract<ServerMessage, { t: 'roundResult' }> = { t: 'roundResult', n, answer, results };
    if (g.duel) {
      const outcome = g.duel.applyRound(n, scores);
      msg.duel = { hp: outcome.hp, multiplier: outcome.multiplier, damage: outcome.damage };
      if (outcome.over && !g.end) {
        const ko = Object.values(outcome.hp).some((hp) => hp <= 0);
        g.end = { winner: outcome.winner, forfeit: false, reason: ko ? 'ko' : 'cap' };
      }
    } else if (n >= g.rounds && !g.end) {
      g.end = { winner: this.partyLeader(), forfeit: false, reason: 'rounds' };
    }
    g.nextAt = now + (g.duel ? DUEL_RESULT_MS : PARTY_RESULT_MS);
    msg.nextAt = g.nextAt;
    g.lastResult = msg;
    this.phase = 'result';
    for (const id of this.memberIds()) out.push({ type: 'send', to: id, msg });
    this.broadcastRoom(out);
    if (g.end?.forfeit) this.finish(out);
  }

  /** Result phase over: next round, or finish when the game is decided. */
  private advance(out: RoomEffect[]): void {
    const g = this.game!;
    if (g.end || g.n >= g.rounds) {
      g.end ??= { winner: g.duel ? g.duel.leader() : this.partyLeader(), forfeit: false, reason: g.duel ? 'cap' : 'rounds' };
      this.finish(out);
      return;
    }
    this.openRound(g.n + 1, out);
  }

  private forfeit(playerId: string, out: RoomEffect[]): void {
    const g = this.game!;
    if (!g.duel || g.end?.forfeit) return;
    g.end = { winner: g.duel.forfeit(playerId), forfeit: true, reason: 'forfeit' };
    if (g.busy === null) this.finish(out);
    // Otherwise the pending call's result finishes it (onRoundOpened / onRoundClosed / onGamesCreated).
  }

  private finish(out: RoomEffect[]): void {
    const g = this.game!;
    if (g.busy === 'finish') return;
    g.busy = 'finish';
    out.push({ type: 'call', call: { op: 'finish', challengeCode: g.challengeCode, roundsPlayed: g.n } });
  }

  private onFinished(out: RoomEffect[]): void {
    const g = this.game;
    if (!g || g.busy !== 'finish') return;
    const standings = this.standings(g);
    const winner = g.duel ? (g.end?.winner ?? null) : undefined;
    this.last = { challengeCode: g.challengeCode, standings, winner, reason: g.end?.reason };
    this.game = null;
    this.phase = 'over';
    for (const m of [...this.members]) if (m.gone) this.removeMember(m.id);
    if (this.members.length === 0) {
      this.closeRoom('empty', out);
      return;
    }
    if (!this.member(this.hostId)) this.passHost(false);
    const msg = this.gameOverMessage(this.last);
    for (const id of this.memberIds()) out.push({ type: 'send', to: id, msg });
    this.broadcastRoom(out);
  }

  private onCallFailed(op: RoomCall['op'], error: ApiErrorCode, out: RoomEffect[]): void {
    if (op === 'createGames') {
      if (this.phase !== 'starting') return;
      this.phase = 'lobby';
      out.push(this.errorTo(this.hostId, error));
      this.broadcastRoom(out);
      return;
    }
    const g = this.game;
    if (!g) return;
    if (op === 'setDeadline') return; // the round still closes at our own deadline
    if (op === 'finish') {
      // Could not finish the rows (they stay `running`); still release the room.
      g.busy = 'finish';
      this.onFinished(out);
      return;
    }
    // openRound / closeRound failed: end the game with what was played.
    for (const id of this.memberIds()) out.push(this.errorTo(id, error));
    g.busy = null;
    g.end ??= { winner: g.duel ? g.duel.leader() : this.partyLeader(), forfeit: false };
    this.finish(out);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------------------------------------------------

  private onTick(out: RoomEffect[]): void {
    const now = this.clock();
    if (now >= this.lastActivity + ROOM_IDLE_MS) {
      this.closeRoom('expired', out);
      return;
    }
    const host = this.member(this.hostId);
    if (host && !host.connected && host.disconnectedAt !== null && now >= host.disconnectedAt + HOST_HANDOVER_MS) {
      if (this.passHost(true)) this.broadcastRoom(out);
    }
    const g = this.game;
    if (!g || g.busy !== null) return;
    if (g.duel) {
      const loser = duelForfeiter(this.members.filter((m) => g.games.has(m.id)), now);
      if (loser !== null) {
        this.forfeit(loser, out);
        return;
      }
    }
    if (this.phase === 'round' && g.deadline !== null && now >= g.deadline + DEADLINE_GRACE_MS) {
      this.closeRound(out);
      return;
    }
    // Nobody here to watch: hold the result phase until someone (re)connects.
    if (this.phase === 'result' && g.nextAt !== null && now >= g.nextAt && this.members.some((m) => m.connected)) {
      this.advance(out);
    }
  }

  private closeRoom(reason: 'empty' | 'expired' | 'admin' | 'shutdown', out: RoomEffect[]): void {
    if (this.isClosed) return;
    this.isClosed = true;
    const g = this.game;
    if (g && g.busy !== 'finish') {
      g.busy = 'finish';
      out.push({ type: 'call', call: { op: 'finish', challengeCode: g.challengeCode, roundsPlayed: g.n } });
    }
    for (const m of this.members) {
      if (reason !== 'empty') out.push(this.errorTo(m.id, 'room_closed'));
      out.push({ type: 'detach', playerId: m.id });
    }
    out.push({ type: 'closed', reason });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------------

  /** Everything a (re)joining player needs to render the current state. */
  private sync(playerId: string, out: RoomEffect[]): void {
    const g = this.game;
    if (g) {
      const gameId = g.games.get(playerId);
      if (gameId === undefined) return;
      out.push({ type: 'send', to: playerId, msg: { t: 'started', gameId, challengeCode: g.challengeCode } });
      if (this.phase === 'round' && g.node) {
        out.push({ type: 'send', to: playerId, msg: this.roundMessage(g) });
        for (const id of g.guessed) out.push({ type: 'send', to: playerId, msg: { t: 'guessed', playerId: id } });
        if (g.countdown && g.deadline !== null) out.push({ type: 'send', to: playerId, msg: { t: 'countdown', deadline: g.deadline } });
      } else if (this.phase === 'result' && g.lastResult) {
        out.push({ type: 'send', to: playerId, msg: g.lastResult });
      }
      return;
    }
    if (this.phase === 'over' && this.last) out.push({ type: 'send', to: playerId, msg: this.gameOverMessage(this.last) });
  }

  private roundMessage(g: Running): ServerMessage {
    const msg: Extract<ServerMessage, { t: 'round' }> = {
      t: 'round',
      n: g.n,
      node: g.node!,
      deadline: g.deadline,
      startedAt: g.startedAt,
    };
    if (g.duel) msg.duel = { hp: g.duel.hp(), multiplier: duelMultiplier(g.n) };
    return msg;
  }

  private gameOverMessage(last: LastGame): ServerMessage {
    const msg: Extract<ServerMessage, { t: 'gameOver' }> = { t: 'gameOver', standings: last.standings, challengeCode: last.challengeCode };
    if (last.winner !== undefined) msg.winner = last.winner;
    if (last.reason !== undefined) msg.reason = last.reason;
    return msg;
  }

  private standings(g: Running): Standing[] {
    const rows: Standing[] = [...g.games.keys()].map((id) => {
      const t = g.totals.get(id) ?? { total: 0, timeMs: 0 };
      const s: Standing = { playerId: id, nickname: g.nicknames.get(id) ?? '', total: t.total, timeMs: t.timeMs };
      if (g.duel) s.hp = g.duel.hpOf(id) ?? 0;
      return s;
    });
    const winner = g.end?.winner ?? null;
    rows.sort((a, b) => {
      if (g.duel && winner !== null) {
        if (a.playerId === winner) return -1;
        if (b.playerId === winner) return 1;
      }
      if (g.duel && (b.hp ?? 0) !== (a.hp ?? 0)) return (b.hp ?? 0) - (a.hp ?? 0);
      return b.total - a.total || a.timeMs - b.timeMs;
    });
    return rows;
  }

  private partyLeader(): string | null {
    const g = this.game;
    if (!g) return null;
    return this.standings(g)[0]?.playerId ?? null;
  }

  private totalOf(playerId: string): number {
    const t = this.game?.totals.get(playerId);
    if (t) return t.total;
    return this.last?.standings.find((s) => s.playerId === playerId)?.total ?? 0;
  }

  private hpOf(playerId: string): number | undefined {
    if (this.game?.duel) return this.game.duel.hpOf(playerId);
    if (this.last && this.last.winner !== undefined) return this.last.standings.find((s) => s.playerId === playerId)?.hp;
    return undefined;
  }

  private broadcastRoom(out: RoomEffect[]): void {
    for (const id of this.memberIds()) out.push({ type: 'send', to: id, msg: { t: 'room', room: this.view(id) } });
  }

  private errorTo(playerId: string, error: ApiErrorCode): RoomEffect {
    return { type: 'send', to: playerId, msg: { t: 'error', error } };
  }

  private requireHost(playerId: string, out: RoomEffect[]): boolean {
    if (!this.member(playerId)) {
      out.push(this.errorTo(playerId, 'not_found'));
      return false;
    }
    if (playerId !== this.hostId) {
      out.push(this.errorTo(playerId, 'not_host'));
      return false;
    }
    return true;
  }

  private requireLobby(playerId: string, out: RoomEffect[]): boolean {
    if (this.phase === 'lobby' || this.phase === 'over') return true;
    out.push(this.errorTo(playerId, 'room_started'));
    return false;
  }

  private member(playerId: string): Member | undefined {
    return this.members.find((m) => m.id === playerId);
  }

  private removeMember(playerId: string): void {
    const i = this.members.findIndex((m) => m.id === playerId);
    if (i < 0) return;
    this.members.splice(i, 1);
    if (playerId === this.hostId) this.passHost(false);
  }

  /**
   * Hand the host role to the earliest member that is still around (connected ones first when `connectedOnly`).
   * Returns whether the host changed.
   */
  private passHost(connectedOnly: boolean): boolean {
    const candidates = this.members
      .filter((m) => m.id !== this.hostId && !m.gone && (!connectedOnly || m.connected))
      .sort((a, b) => a.seq - b.seq);
    const preferred = candidates.find((m) => m.connected) ?? (connectedOnly ? undefined : candidates[0]);
    if (!preferred) return false;
    this.hostId = preferred.id;
    return true;
  }

  private touch(now: number): void {
    this.lastActivity = Math.max(this.lastActivity, now);
  }
}
