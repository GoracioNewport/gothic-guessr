/**
 * Live room registry (SPEC §10.6): every open room's {@link RoomMachine}, its attached sockets, a serial event queue
 * and one wake-up timer. It carries out the machine's effects: messages go to the attached sockets, service calls to
 * the GameService room API (core/games.ts) with their results fed back as events. Rooms live only in memory; the
 * DB sees them as `rooms_log` rows and, once started, as a challenge with one game per player.
 *
 * Used by server/rooms/hub.ts (WebSocket), server/routes/rooms.ts (REST) and the admin (see server/rooms/index.ts).
 */
import type { AdminRoom, PublicSettings, RoomType, RoomView, ServerMessage } from '../../shared/api';
import { ApiFailure } from '../core/errors';
import type { GameService } from '../core/games';
import { RoomMachine } from '../core/party';
import type { RoomCall, RoomEffect, RoomEvent } from '../core/party';
import { roomCode } from '../core/random';
import { RateLimiter } from '../core/ratelimit';
import type { Repository } from '../core/repository';
import { parseSettings } from '../core/settings';

/** A connection as the registry sees it (the hub's WebSocket wrapper implements it). */
export interface RoomSocket {
  readonly playerId: string;
  /** Room the socket is attached to, maintained by the registry. */
  roomCode: string | null;
  send(msg: ServerMessage): void;
}

export interface RoomRegistryDeps {
  games: GameService;
  repo: Repository;
  clock: () => number;
  /** Errors in effects/calls (default: console.error). */
  log?: (message: string, err?: unknown) => void;
  /** Arm real timers for deadlines and auto-advance (default true; tests may drive `tickAll` by hand). */
  timers?: boolean;
}

/** Party rooms default to a 2 min time limit when the creator does not choose one (SPEC §10.1). */
export const PARTY_DEFAULT_TIME_LIMIT_S = 120;
/** Upper bound of rooms held in memory. */
export const MAX_ROOMS = 2000;
/** Rooms a player may create: 10 per 10 minutes. */
export const ROOM_CREATE_LIMIT = { limit: 10, windowMs: 10 * 60_000 };
/**
 * Rooms one client address may create: 20 per 30 minutes (an idle room lives 30 min), so filling {@link MAX_ROOMS}
 * takes about a hundred addresses instead of a handful of IPs with fresh players.
 */
export const ROOM_CREATE_IP_LIMIT = { limit: 20, windowMs: 30 * 60_000 };

const MAX_TIMER_MS = 2 ** 31 - 1;

interface Entry {
  machine: RoomMachine;
  sockets: Map<string, RoomSocket>;
  queue: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Entry>();
  private readonly games: GameService;
  private readonly repo: Repository;
  private readonly clock: () => number;
  private readonly log: (message: string, err?: unknown) => void;
  private readonly timers: boolean;
  private readonly createLimiter = new RateLimiter(ROOM_CREATE_LIMIT);
  private readonly createIpLimiter = new RateLimiter(ROOM_CREATE_IP_LIMIT);
  private readonly unsubscribe: () => void;
  private shuttingDown = false;

  constructor(deps: RoomRegistryDeps) {
    this.games = deps.games;
    this.repo = deps.repo;
    this.clock = deps.clock;
    this.log = deps.log ?? ((m, e) => console.error(`[rooms] ${m}`, e ?? ''));
    this.timers = deps.timers ?? true;
    // Guesses arrive over REST; the room only needs to know that a player's round n is over.
    this.unsubscribe = this.games.events.on('guess', (e) => {
      if (e.roomCode === null) return;
      void this.dispatch(e.roomCode, { type: 'guess', playerId: e.playerId, n: e.n, challengeCode: e.challengeCode });
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // REST side
  // -------------------------------------------------------------------------------------------------------------------

  /** Validate settings for a room type; party without a time limit gets the 2 min default. Throws `bad_request`. */
  parseSettings(raw: unknown, type: RoomType, isNew = false): PublicSettings {
    let input = raw;
    if (isNew && type === 'party' && typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const r = raw as Record<string, unknown>;
      if (r.timeLimit === undefined) input = { ...r, timeLimit: PARTY_DEFAULT_TIME_LIMIT_S };
    }
    return parseSettings(input, this.games.worldSlugs, type);
  }

  /**
   * Create a room with `host` as its (not yet connected) host. Banned players must be refused by the caller.
   * `clientKey` = the creator's rate-limit address key (core/ip.ts); null skips the per-address limit (tests, tools).
   */
  async create(host: { id: string; nickname: string }, rawType: unknown, rawSettings: unknown, clientKey: string | null = null): Promise<string> {
    if (this.shuttingDown) throw new ApiFailure('conflict', 'shutting down');
    if (rawType !== 'party' && rawType !== 'duel') throw new ApiFailure('bad_request', 'type');
    const settings = this.parseSettings(rawSettings, rawType, true);
    if (this.rooms.size >= MAX_ROOMS) throw new ApiFailure('rate_limited', 'too many rooms', 60);
    const now = this.clock();
    const refuse = (d: { retryAfterMs: number }): ApiFailure =>
      new ApiFailure('rate_limited', 'rooms', Math.max(1, Math.ceil(d.retryAfterMs / 1000)));
    if (clientKey !== null) {
      const byIp = this.createIpLimiter.peek(`ip:${clientKey}`, now);
      if (!byIp.ok) throw refuse(byIp);
    }
    const decision = this.createLimiter.take(`player:${host.id}`, now);
    if (!decision.ok) throw refuse(decision);
    if (clientKey !== null) this.createIpLimiter.take(`ip:${clientKey}`, now);
    let code = roomCode();
    for (let i = 0; this.rooms.has(code); i++) {
      if (i > 50) throw new Error('rooms: could not find a free code');
      code = roomCode();
    }
    const machine = new RoomMachine(
      { code, type: rawType, settings, hostId: host.id, hostNickname: host.nickname },
      { clock: this.clock, parseSettings: (raw, type) => this.parseSettings(raw, type) },
    );
    this.rooms.set(code, { machine, sockets: new Map(), queue: Promise.resolve(), timer: null });
    this.arm(code);
    try {
      await this.repo.logRoomCreated(code, rawType, host.id, this.clock());
    } catch (err) {
      this.log('logRoomCreated failed', err);
    }
    return code;
  }

  /** The room as `playerId` sees it, or null when unknown. */
  view(code: string, playerId: string | null): RoomView | null {
    const entry = this.rooms.get(normaliseCode(code));
    return entry ? entry.machine.view(playerId) : null;
  }

  has(code: string): boolean {
    return this.rooms.has(normaliseCode(code));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Socket side
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Queue an event for a room; resolves when it and every effect it caused (service calls included) are done.
   * `origin` is the socket that sent it (needed for `join`: the socket is not attached yet). Unknown room → false.
   */
  dispatch(code: string, event: RoomEvent, origin?: RoomSocket): Promise<boolean> {
    const entry = this.rooms.get(code);
    if (!entry) return Promise.resolve(false);
    const job = entry.queue.then(() => this.process(code, entry, event, origin));
    entry.queue = job.catch((err) => this.log(`room ${code}: ${event.type} failed`, err));
    return entry.queue.then(() => true);
  }

  /** True when `socket` is the one attached for its player in `code` (a replaced socket is not). */
  isAttached(code: string, socket: RoomSocket): boolean {
    return this.rooms.get(code)?.sockets.get(socket.playerId) === socket;
  }

  /** Unbind a socket from a room without an event (the caller dispatched `disconnect` for it first). */
  release(code: string, socket: RoomSocket): void {
    const entry = this.rooms.get(code);
    if (entry && entry.sockets.get(socket.playerId) === socket) entry.sockets.delete(socket.playerId);
    if (socket.roomCode === code) socket.roomCode = null;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Admin, stats, lifecycle
  // -------------------------------------------------------------------------------------------------------------------

  list(): AdminRoom[] {
    return [...this.rooms.values()].map((e) => e.machine.adminView());
  }

  get size(): number {
    return this.rooms.size;
  }

  /** Rooms with a game in progress. */
  get playing(): number {
    let n = 0;
    for (const e of this.rooms.values()) if (e.machine.gameRunning) n++;
    return n;
  }

  /** Admin: close a room (members get `error room_closed`, a running game is finished). False when unknown. */
  async close(code: string): Promise<boolean> {
    const c = normaliseCode(code);
    if (!this.rooms.has(c)) return false;
    await this.dispatch(c, { type: 'close', reason: 'admin' });
    return true;
  }

  /** Run a `tick` in every room now (timers do this on their own; tests call it after moving a fake clock). */
  async tickAll(): Promise<void> {
    await Promise.all([...this.rooms.keys()].map((code) => this.dispatch(code, { type: 'tick' })));
  }

  /** Resolves when every queued event of every room has been processed. */
  async idle(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const queues = [...this.rooms.values()].map((e) => e.queue);
      await Promise.all(queues);
      if ([...this.rooms.values()].every((e, j) => e.queue === queues[j])) return;
    }
  }

  /** Shutdown: finish running room games, close every room, stop listening to game events. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all([...this.rooms.keys()].map((code) => this.dispatch(code, { type: 'close', reason: 'shutdown' })));
    for (const entry of this.rooms.values()) if (entry.timer) clearTimeout(entry.timer);
    this.rooms.clear();
    this.unsubscribe();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------------------------------------------------

  private async process(code: string, entry: Entry, event: RoomEvent, origin: RoomSocket | undefined): Promise<void> {
    const pending: RoomEvent[] = [event];
    while (pending.length > 0) {
      const ev = pending.shift()!;
      const effects = entry.machine.handle(ev);
      for (const effect of effects) {
        const next = await this.apply(code, entry, effect, origin);
        if (next) pending.push(next);
      }
    }
    if (this.rooms.get(code) === entry) this.arm(code);
  }

  private async apply(code: string, entry: Entry, effect: RoomEffect, origin: RoomSocket | undefined): Promise<RoomEvent | null> {
    switch (effect.type) {
      case 'send': {
        const socket = entry.sockets.get(effect.to) ?? (origin && origin.playerId === effect.to ? origin : undefined);
        socket?.send(effect.msg);
        return null;
      }
      case 'attach': {
        if (!origin || origin.playerId !== effect.playerId) return null;
        const old = entry.sockets.get(effect.playerId);
        if (old && old !== origin) {
          // One live socket per player and room: the newest tab wins.
          old.send({ t: 'error', error: 'conflict' });
          old.roomCode = null;
        }
        entry.sockets.set(effect.playerId, origin);
        origin.roomCode = code;
        return null;
      }
      case 'detach': {
        const socket = entry.sockets.get(effect.playerId);
        if (socket) {
          entry.sockets.delete(effect.playerId);
          if (socket.roomCode === code) socket.roomCode = null;
        }
        return null;
      }
      case 'call':
        return this.call(code, effect.call);
      case 'closed': {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        for (const socket of entry.sockets.values()) if (socket.roomCode === code) socket.roomCode = null;
        entry.sockets.clear();
        if (this.rooms.get(code) === entry) this.rooms.delete(code);
        try {
          await this.repo.logRoomClosed(code, this.clock());
        } catch (err) {
          this.log('logRoomClosed failed', err);
        }
        return null;
      }
    }
  }

  private async call(code: string, call: RoomCall): Promise<RoomEvent | null> {
    try {
      switch (call.op) {
        case 'createGames': {
          const r = await this.games.createRoomGames({
            type: call.type,
            settings: call.settings,
            roomCode: code,
            hostId: call.hostId,
            playerIds: call.playerIds,
          });
          return { type: 'gamesCreated', challengeCode: r.challengeCode, games: r.games, rounds: r.rounds, settings: r.settings };
        }
        case 'openRound': {
          const r = await this.games.openRoomRound(call.challengeCode, call.n, { startedAt: call.startedAt, deadline: call.deadline });
          return { type: 'roundOpened', n: r.n, node: r.node };
        }
        case 'setDeadline':
          await this.games.setRoomRoundDeadline(call.challengeCode, call.n, call.deadline);
          return null;
        case 'closeRound': {
          const r = await this.games.closeRoomRound(call.challengeCode, call.n);
          return { type: 'roundClosed', n: r.n, answer: r.answer, results: r.results };
        }
        case 'finish':
          await this.games.finishRoomChallenge(call.challengeCode, call.roundsPlayed);
          return { type: 'finished' };
      }
    } catch (err) {
      if (!(err instanceof ApiFailure)) this.log(`room ${code}: ${call.op} failed`, err);
      return { type: 'callFailed', op: call.op, error: err instanceof ApiFailure ? err.code : 'internal' };
    }
  }

  /** (Re)arm the room's single timer for its next wake-up. */
  private arm(code: string): void {
    const entry = this.rooms.get(code);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (!this.timers || this.shuttingDown) return;
    const at = entry.machine.nextWakeAt();
    if (at === null) return;
    const delay = Math.max(0, Math.min(MAX_TIMER_MS, at - this.clock()));
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.dispatch(code, { type: 'tick' });
    }, delay);
    entry.timer.unref?.();
  }
}

/** Room codes are case-insensitive in links and the join box. */
export function normaliseCode(code: string): string {
  return code.trim().toUpperCase();
}
