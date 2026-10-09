/**
 * Reconnecting WebSocket client for the room protocol (SPEC §10.6): `ws(s)://<host>/ws?token=<device token>`,
 * JSON {@link ClientMessage}s out, {@link ServerMessage}s in.
 *
 * - One socket per tab. {@link RoomConnection.start} opens it; every successful (re)open calls `onOpen`, where the
 *   room page sends `join {code}`: the server then re-sends the full state (room, started, round/roundResult or
 *   gameOver), which is how a reload or a dropped connection resumes.
 * - Lost connections are retried with exponential backoff ({@link RECONNECT_DELAYS_MS}, plus jitter), immediately
 *   when the browser reports `online` again.
 * - Heartbeat: an app-level `{t:'ping'}` every {@link PING_INTERVAL_MS}; when nothing at all arrives for
 *   {@link SILENCE_TIMEOUT_MS} the socket is treated as dead and replaced (the server also pings at the protocol
 *   level, which the browser answers on its own).
 * - Close code 4401 (unknown token, e.g. a wiped database): `onAuthFailure` may mint a new token (the REST client
 *   does that on its next call) and the connection retries once; without a fresh token it stops. Close code 4403
 *   (banned) stops for good. {@link RoomConnection.stop} stops on the caller's decision (kicked, room closed,
 *   this tab replaced by a newer one).
 *
 * The WebSocket constructor, the timers and the clock are injectable for tests.
 */
import type { ClientMessage, ServerMessage } from '../../shared/api';

/** Close codes sent by the server hub (server/rooms/hub.ts). */
export const CLOSE_AUTH = 4401;
export const CLOSE_BANNED = 4403;

/** Waits before reconnect attempt 1, 2, 3, …; the last value repeats. */
export const RECONNECT_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000, 8000];
/** Up to this fraction of the delay is added as random jitter. */
export const RECONNECT_JITTER = 0.25;
export const PING_INTERVAL_MS = 20_000;
/** No message (not even a pong) for this long → the socket is considered dead. */
export const SILENCE_TIMEOUT_MS = 45_000;

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped';

/** Why the connection stopped for good. */
export type StopReason = 'caller' | 'auth' | 'banned';

/** The subset of the browser WebSocket the client uses. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

export interface RoomConnectionOptions {
  /** The device token, read on every (re)connect; null = cannot connect (treated like a 4401). */
  token: () => string | null;
  /** Called on every open; send `join` here. */
  onOpen?: () => void;
  onMessage: (msg: ServerMessage) => void;
  onStatus?: (status: ConnectionStatus) => void;
  /** Connection stopped for good (not on a plain {@link RoomConnection.stop} by the caller). */
  onStopped?: (reason: Exclude<StopReason, 'caller'>) => void;
  /** 4401: try to obtain a valid token; resolve true to retry once. */
  onAuthFailure?: () => Promise<boolean>;
  /** Base URL, default derived from `location` (`ws:`/`wss:` + host + `/ws`). */
  url?: string;
  socketFactory?: SocketFactory;
  timers?: Timers;
  random?: () => number;
  /** Listen to `online` on this target (default `window` when present). */
  eventTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
}

const OPEN = 1;

/** `ws://host/ws` for the current page (`wss:` on https). */
export function defaultSocketUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws`;
}

/** The socket URL with the token as a query parameter. */
export function socketUrl(base: string, token: string): string {
  return `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/** Delay before reconnect attempt `attempt` (1-based), with jitter from `random` in [0, 1). */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const i = Math.min(Math.max(attempt, 1), RECONNECT_DELAYS_MS.length) - 1;
  const base = RECONNECT_DELAYS_MS[i]!;
  return Math.round(base * (1 + RECONNECT_JITTER * random()));
}

const SERVER_TYPES = new Set(['room', 'kicked', 'started', 'round', 'guessed', 'countdown', 'roundResult', 'gameOver', 'error', 'pong']);

/** Parse one server frame; null for anything that is not a known message object. */
export function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== 'string') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const t = (raw as { t?: unknown }).t;
  return typeof t === 'string' && SERVER_TYPES.has(t) ? (raw as ServerMessage) : null;
}

const browserTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
};

export class RoomConnection {
  private readonly opts: RoomConnectionOptions;
  private readonly timers: Timers;
  private readonly factory: SocketFactory;
  private readonly random: () => number;
  private readonly online = (): void => this.reconnectNow();
  private socket: SocketLike | null = null;
  private state: ConnectionStatus = 'idle';
  /** Failed attempts since the last successful open. */
  private attempt = 0;
  private retryTimer: unknown = null;
  private pingTimer: unknown = null;
  private lastMessageAt = 0;
  private authRetried = false;

  constructor(opts: RoomConnectionOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? browserTimers;
    this.factory = opts.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.random = opts.random ?? Math.random;
  }

  get status(): ConnectionStatus {
    return this.state;
  }

  /** Open the connection (idempotent while running). */
  start(): void {
    if (this.state !== 'idle') return;
    const target = this.opts.eventTarget === undefined ? (typeof window === 'undefined' ? null : window) : this.opts.eventTarget;
    target?.addEventListener('online', this.online);
    this.connect();
  }

  /** Send a message; false when the socket is not open (the caller re-syncs on the next open anyway). */
  send(msg: ClientMessage): boolean {
    const s = this.socket;
    if (!s || s.readyState !== OPEN) return false;
    try {
      s.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** Stop for good: close the socket, cancel retries. */
  stop(): void {
    this.halt();
  }

  /** Skip the backoff wait (browser back online, or the player pressed "reconnect"). */
  reconnectNow(): void {
    if (this.state === 'stopped' || this.state === 'idle') return;
    // A socket exists: it is open or still connecting.
    if (this.socket) return;
    this.clearRetry();
    this.connect();
  }

  /** Restart after a stop (e.g. "Use this tab" after another tab took over). */
  restart(): void {
    this.halt();
    this.state = 'idle';
    this.attempt = 0;
    this.authRetried = false;
    this.start();
  }

  // --- internals ------------------------------------------------------------------------------

  private setStatus(next: ConnectionStatus): void {
    if (this.state === next) return;
    this.state = next;
    this.opts.onStatus?.(next);
  }

  private connect(): void {
    const token = this.opts.token();
    if (!token) {
      void this.handleAuthFailure();
      return;
    }
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let socket: SocketLike;
    try {
      socket = this.factory(socketUrl(this.opts.url ?? defaultSocketUrl(), token));
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.authRetried = false;
      this.lastMessageAt = Date.now();
      this.setStatus('open');
      this.startPing();
      this.opts.onOpen?.();
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.lastMessageAt = Date.now();
      const msg = parseServerMessage(ev.data);
      if (msg && msg.t !== 'pong') this.opts.onMessage(msg);
    };
    socket.onerror = () => {
      /* onclose follows */
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopPing();
      if (this.state === 'stopped') return;
      if (ev.code === CLOSE_BANNED) {
        this.halt();
        this.opts.onStopped?.('banned');
        return;
      }
      if (ev.code === CLOSE_AUTH) {
        void this.handleAuthFailure();
        return;
      }
      this.scheduleRetry();
    };
  }

  private async handleAuthFailure(): Promise<void> {
    if (this.state === 'stopped') return;
    if (!this.authRetried && this.opts.onAuthFailure) {
      this.authRetried = true;
      this.setStatus('reconnecting');
      let ok = false;
      try {
        ok = await this.opts.onAuthFailure();
      } catch {
        ok = false;
      }
      if ((this.state as ConnectionStatus) === 'stopped') return;
      if (ok) {
        this.connect();
        return;
      }
    }
    this.halt();
    this.opts.onStopped?.('auth');
  }

  private scheduleRetry(): void {
    this.clearRetry();
    this.attempt++;
    this.setStatus('reconnecting');
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      if (this.state !== 'stopped') this.connect();
    }, reconnectDelay(this.attempt, this.random));
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = this.timers.setInterval(() => {
      const s = this.socket;
      if (!s) return;
      if (Date.now() - this.lastMessageAt > SILENCE_TIMEOUT_MS) {
        // Dead connection that never fired `close`: drop it and reconnect.
        this.socket = null;
        this.stopPing();
        try {
          s.close();
        } catch {
          /* ignore */
        }
        this.scheduleRetry();
        return;
      }
      this.send({ t: 'ping' });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) this.timers.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private halt(): void {
    this.clearRetry();
    this.stopPing();
    const target = this.opts.eventTarget === undefined ? (typeof window === 'undefined' ? null : window) : this.opts.eventTarget;
    target?.removeEventListener('online', this.online);
    const s = this.socket;
    this.socket = null;
    this.setStatus('stopped');
    if (s) {
      try {
        s.close(1000, 'bye');
      } catch {
        /* ignore */
      }
    }
  }
}
