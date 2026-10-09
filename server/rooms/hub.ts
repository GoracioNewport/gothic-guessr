/**
 * WebSocket hub at `/ws?token=<device token>` (SPEC §10.6), on the same Node HTTP server as the API (`ws` library,
 * `noServer` mode on the `upgrade` event).
 *
 *   - Auth: the token is checked once on connect. Unknown token → `{t:'error', error:'auth'}` and close 4401; a banned
 *     player → `error banned`, close 4403. The ban is checked again on every `join`.
 *   - One socket per tab; a PLAYER is connected in at most one room. Joining another room disconnects the socket
 *     from the first one (a duel then runs its 60 s forfeit clock). A newer socket of the same player that joins any
 *     room replaces the player's socket in every room (the same room or another), and the replaced one gets
 *     `error conflict`. Joins of one player are processed one at a time, so parallel joins cannot slip past this.
 *   - At most {@link MAX_SOCKETS_PER_PLAYER} open sockets per player: a newer one evicts the oldest (`error conflict`,
 *     close {@link CLOSE_REPLACED}). At most {@link MAX_SOCKETS_PER_IP} per client address (core/ip.ts): more are
 *     refused (`error rate_limited`, close {@link CLOSE_TOO_MANY}).
 *   - Messages are JSON {@link ClientMessage}s (≤ 4 KB, ≤ 20 per 5 s per PLAYER across all of its sockets, else
 *     `error rate_limited`). A join of an unknown code counts against the REST `roomMiss` limit of the address
 *     (routes/rooms.ts); once that is spent every join gets `error rate_limited`.
 *   - Heartbeat: a protocol ping every 30 s; a socket that missed the previous pong is terminated (→ `disconnect`).
 *     The app-level `{t:'ping'}` is answered with `{t:'pong'}` and keeps nothing else alive.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { ClientMessage, ServerMessage } from '../../shared/api';
import { KeyedMutex } from '../core/mutex';
import type { PlayerService } from '../core/players';
import { RateLimiter } from '../core/ratelimit';
import type { RateLimits } from '../core/ratelimit';
import type { Repository } from '../core/repository';
import type { RoomRegistry, RoomSocket } from './registry';
import { normaliseCode } from './registry';

export const WS_PATH = '/ws';
export const HEARTBEAT_MS = 30_000;
export const MAX_MESSAGE_BYTES = 4096;
export const MESSAGE_LIMIT = { limit: 20, windowMs: 5_000 };
/** Open sockets per player (tabs); a newer one evicts the oldest. */
export const MAX_SOCKETS_PER_PLAYER = 4;
/** Open sockets per client address (a LAN party behind one NAT fits); more are refused. */
export const MAX_SOCKETS_PER_IP = 64;

/** WebSocket close codes. */
export const CLOSE_AUTH = 4401;
export const CLOSE_BANNED = 4403;
export const CLOSE_REPLACED = 4409;
export const CLOSE_TOO_MANY = 4429;

export interface HubDeps {
  registry: RoomRegistry;
  players: PlayerService;
  repo: Repository;
  clock: () => number;
  /** Shared REST limits; the hub uses `roomMiss` for joins of unknown codes (omitted: no miss limit). */
  limits?: RateLimits;
  /** Rate-limit key of an upgrade request's client (core/ip.ts `clientKey`); default: the socket address. */
  clientKey?: (req: IncomingMessage) => string;
  heartbeatMs?: number;
  log?: (message: string, err?: unknown) => void;
}

interface UpgradeServer {
  on(event: 'upgrade', listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off(event: 'upgrade', listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

let nextConnId = 1;

class Connection implements RoomSocket {
  readonly id = nextConnId++;
  roomCode: string | null = null;
  alive = true;

  constructor(
    readonly ws: WebSocket,
    readonly playerId: string,
    /** Rate-limit key of the client address. */
    readonly ip: string,
  ) {}

  send(msg: ServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

export class RoomHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly connections = new Set<Connection>();
  private readonly limiter = new RateLimiter(MESSAGE_LIMIT);
  /** Serializes the joins of one player (one room per player). */
  private readonly joins = new KeyedMutex();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly servers: { server: UpgradeServer; listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void }[] = [];
  private readonly log: (message: string, err?: unknown) => void;

  constructor(private readonly deps: HubDeps) {
    this.log = deps.log ?? ((m, e) => console.error(`[ws] ${m}`, e ?? ''));
    this.heartbeat = setInterval(() => this.beat(), deps.heartbeatMs ?? HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  /** Open sockets (admin dashboard). */
  get socketCount(): number {
    return this.connections.size;
  }

  /** Handle `upgrade` requests for {@link WS_PATH} on an HTTP server. */
  attach(server: UpgradeServer): void {
    const listener = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
      void this.upgrade(req, socket, head);
    };
    server.on('upgrade', listener);
    this.servers.push({ server, listener });
  }

  /** Close every socket and stop the heartbeat. */
  close(): void {
    clearInterval(this.heartbeat);
    for (const { server, listener } of this.servers) server.off('upgrade', listener);
    this.servers.length = 0;
    for (const conn of this.connections) conn.ws.terminate();
    this.connections.clear();
    this.wss.close();
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const ip = this.deps.clientKey ? this.deps.clientKey(req) : (req.socket.remoteAddress ?? 'unknown');
    let player: Awaited<ReturnType<PlayerService['authenticate']>> = null;
    try {
      player = await this.deps.players.authenticate(url.searchParams.get('token'));
    } catch (err) {
      this.log('auth failed', err);
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (!player) {
        sendRaw(ws, { t: 'error', error: 'auth' });
        ws.close(CLOSE_AUTH, 'auth');
        return;
      }
      if (player.banned) {
        sendRaw(ws, { t: 'error', error: 'banned' });
        ws.close(CLOSE_BANNED, 'banned');
        return;
      }
      let fromIp = 0;
      for (const c of this.connections) if (c.ip === ip) fromIp++;
      if (fromIp >= MAX_SOCKETS_PER_IP) {
        sendRaw(ws, { t: 'error', error: 'rate_limited' });
        ws.close(CLOSE_TOO_MANY, 'too many sockets');
        return;
      }
      this.accept(ws, player.id, ip);
    });
  }

  private accept(ws: WebSocket, playerId: string, ip: string): void {
    const mine = [...this.connections].filter((c) => c.playerId === playerId);
    // Oldest first (Set order = accept order): keep room for the new socket.
    for (const old of mine.slice(0, Math.max(0, mine.length - MAX_SOCKETS_PER_PLAYER + 1))) {
      old.send({ t: 'error', error: 'conflict' });
      this.connections.delete(old); // the close handler finishes the room side
      old.ws.close(CLOSE_REPLACED, 'replaced');
    }
    const conn = new Connection(ws, playerId, ip);
    this.connections.add(conn);
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      conn.alive = true;
      if (isBinary) {
        conn.send({ t: 'error', error: 'bad_request' });
        return;
      }
      void this.onMessage(conn, data.toString()).catch((err) => this.log('message failed', err));
    });
    ws.on('close', () => {
      this.connections.delete(conn);
      const code = conn.roomCode;
      if (code && this.deps.registry.isAttached(code, conn)) {
        void this.deps.registry.dispatch(code, { type: 'disconnect', playerId: conn.playerId });
      }
    });
    ws.on('error', (err) => this.log('socket error', err));
  }

  private async onMessage(conn: Connection, text: string): Promise<void> {
    if (!this.connections.has(conn)) return; // evicted, closing
    if (!this.limiter.take(`player:${conn.playerId}`, this.deps.clock()).ok) {
      conn.send({ t: 'error', error: 'rate_limited' });
      return;
    }
    const msg = parseMessage(text);
    if (!msg) {
      conn.send({ t: 'error', error: 'bad_request' });
      return;
    }
    const registry = this.deps.registry;
    const playerId = conn.playerId;
    switch (msg.t) {
      case 'ping':
        conn.send({ t: 'pong' });
        return;
      case 'join':
        await this.joins.run(playerId, () => this.join(conn, normaliseCode(msg.code)));
        return;
      case 'leave':
      case 'start':
      case 'next':
      case 'endRound':
      case 'settings':
      case 'kick': {
        const code = conn.roomCode;
        if (!code || !registry.isAttached(code, conn)) {
          conn.send({ t: 'error', error: 'not_found' });
          return;
        }
        if (msg.t === 'leave') await registry.dispatch(code, { type: 'leave', playerId });
        else if (msg.t === 'start') await registry.dispatch(code, { type: 'start', playerId });
        else if (msg.t === 'next') await registry.dispatch(code, { type: 'next', playerId });
        else if (msg.t === 'endRound') await registry.dispatch(code, { type: 'endRound', playerId });
        else if (msg.t === 'settings') {
          await registry.dispatch(code, { type: 'settings', playerId, settings: msg.settings, roomType: msg.type });
        } else await registry.dispatch(code, { type: 'kick', playerId, target: msg.playerId });
        return;
      }
    }
  }

  /** `join` of one socket; runs under the player's join lock. */
  private async join(conn: Connection, code: string): Promise<void> {
    const registry = this.deps.registry;
    const playerId = conn.playerId;
    if (!this.connections.has(conn)) return;
    const player = await this.deps.repo.getPlayer(playerId);
    if (!player) {
      conn.send({ t: 'error', error: 'auth' });
      return;
    }
    if (player.banned) {
      conn.send({ t: 'error', error: 'banned' });
      return;
    }
    const limits = this.deps.limits;
    const missKey = `ip:${conn.ip}`;
    if (limits && !limits.peek('roomMiss', missKey, this.deps.clock()).ok) {
      conn.send({ t: 'error', error: 'rate_limited' });
      return;
    }
    if (!registry.has(code)) {
      limits?.check('roomMiss', missKey, this.deps.clock());
      conn.send({ t: 'error', error: 'not_found' });
      return;
    }
    // One room per player: this socket's previous room, and any other socket of the player sitting in another room.
    for (const other of [...this.connections]) {
      if (other.playerId !== playerId) continue;
      const where = other.roomCode;
      if (!where || where === code) continue; // the same room: the registry's attach replaces the socket
      if (!registry.isAttached(where, other)) continue;
      if (other !== conn) other.send({ t: 'error', error: 'conflict' });
      await registry.dispatch(where, { type: 'disconnect', playerId });
      registry.release(where, other);
    }
    if (!this.connections.has(conn)) return;
    const found = await registry.dispatch(code, { type: 'join', playerId, nickname: player.nickname }, conn);
    if (!found) conn.send({ t: 'error', error: 'not_found' });
  }

  private beat(): void {
    for (const conn of this.connections) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        conn.ws.terminate();
      }
    }
  }
}

function sendRaw(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Validate a client message; null when malformed. */
export function parseMessage(text: string): ClientMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'join':
      return typeof m.code === 'string' && /^[A-Za-z]{5}$/.test(m.code.trim()) ? { t: 'join', code: m.code } : null;
    case 'leave':
    case 'start':
    case 'next':
    case 'endRound':
    case 'ping':
      return { t: m.t };
    case 'settings':
      if (m.type !== undefined && m.type !== 'party' && m.type !== 'duel') return null;
      return m.type === undefined
        ? { t: 'settings', settings: m.settings as never }
        : { t: 'settings', type: m.type, settings: m.settings as never };
    case 'kick':
      return typeof m.playerId === 'string' && m.playerId.length <= 64 ? { t: 'kick', playerId: m.playerId } : null;
    default:
      return null;
  }
}
