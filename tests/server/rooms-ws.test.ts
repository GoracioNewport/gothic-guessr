/**
 * Rooms end to end: a real HTTP server on port 0 (temp in-memory DB, fixture worlds, fake clock), the rooms plugin
 * with its WebSocket hub at /ws, `ws` clients and REST over fetch. A party of three with a disconnect/reconnect, a
 * duel to KO with guesses via REST, auth/ban refusals and the admin source.
 */
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type {
  ChallengeView,
  CreateRoomResponse,
  GameView,
  LeaderboardView,
  PanoNode,
  RoomView,
  ServerMessage,
  WorldGuess,
} from '../../shared/api';
import { registeredAdminRoomsSource } from '../../server/admin/rooms';
import { createRoomsPlugin, roomRegistryOf, roomsAdminSource } from '../../server/rooms';
import type { ServerPlugin } from '../../server/plugins';
import { nodeByKey } from '../../server/core/worlds';
import { harness } from './helpers';
import type { Harness } from './helpers';

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;

let h: Harness;
let plugin: ServerPlugin;
let server: ServerType;
let base: string;

beforeAll(async () => {
  plugin = createRoomsPlugin({ heartbeatMs: 60_000 });
  h = harness({ app: { plugins: [plugin] } });
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: h.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  plugin.attach!(server, h.services);
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await plugin.close?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  h.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------

class Player {
  token = '';
  id = '';
  constructor(private readonly ip: string) {}

  async register(): Promise<this> {
    const res = await this.call<{ token: string; player: { id: string } }>('POST', '/api/players');
    expect(res.status).toBe(201);
    this.token = res.body.token;
    this.id = res.body.player.id;
    return this;
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { 'x-forwarded-for': this.ip };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`http://${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }

  /** The score, or 'pending' while another room player still has the round open (nothing is revealed then). */
  async guess(gameId: string, guess: WorldGuess | null): Promise<number | 'pending'> {
    const res = await this.call<{ score: number; pending?: true; answer?: WorldGuess; distanceM: number | null }>(
      'POST',
      `/api/games/${gameId}/guess`,
      { guess },
    );
    expect(res.status).toBe(200);
    if (res.body.pending) {
      expect(res.body).toMatchObject({ score: 0, distanceM: null });
      expect(res.body.answer).toBeUndefined();
      return 'pending';
    }
    return res.body.score;
  }
}

class Socket {
  readonly messages: ServerMessage[] = [];
  private readonly taken = new Set<number>();
  private readonly listeners = new Set<() => void>();
  closeCode: number | null = null;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()) as ServerMessage);
      for (const l of [...this.listeners]) l();
    });
    ws.on('close', (code) => {
      this.closeCode = code;
      for (const l of [...this.listeners]) l();
    });
  }

  static open(token: string | null): Promise<Socket> {
    const ws = new WebSocket(`ws://${base}/ws${token === null ? '' : `?token=${encodeURIComponent(token)}`}`);
    const socket = new Socket(ws);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(socket));
      ws.once('error', reject);
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** The next not yet taken message of kind `t` matching `pred` (waits up to 3 s). */
  next<T extends ServerMessage['t']>(t: T, pred: (m: Msg<T>) => boolean = () => true): Promise<Msg<T>> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        for (let i = 0; i < this.messages.length; i++) {
          const m = this.messages[i]!;
          if (this.taken.has(i) || m.t !== t || !pred(m as Msg<T>)) continue;
          this.taken.add(i);
          resolve(m as Msg<T>);
          return true;
        }
        return false;
      };
      if (check()) return;
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`timeout waiting for ${t}; got ${JSON.stringify(this.messages.map((m) => m.t))}`));
      }, 3000);
      const listener = (): void => {
        if (check()) {
          clearTimeout(timer);
          this.listeners.delete(listener);
        }
      };
      this.listeners.add(listener);
    });
  }

  /** Wait for the room view that satisfies `pred`. */
  room(pred: (r: RoomView) => boolean = () => true): Promise<RoomView> {
    return this.next('room', (m) => pred(m.room)).then((m) => m.room);
  }

  has<T extends ServerMessage['t']>(t: T, pred: (m: Msg<T>) => boolean = () => true): boolean {
    return this.messages.some((m, i) => m.t === t && !this.taken.has(i) && pred(m as Msg<T>));
  }

  closed(): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((resolve) => this.ws.once('close', (code) => resolve(code)));
  }

  close(): Promise<number> {
    this.ws.close();
    return this.closed();
  }
}

/** The answer of a round, from the private manifests (the test plays a perfect player). */
function answerOf(node: PanoNode): WorldGuess {
  for (const world of h.services.worlds.values()) {
    const n = nodeByKey(world, node.key);
    if (n) return { world: world.manifest.world, x: n.x, z: n.z };
  }
  throw new Error(`unknown key ${node.key}`);
}

/** A guess in the right world but far away (scores 0 on the fixture: > diagonal). */
function farGuess(node: PanoNode): WorldGuess {
  const a = answerOf(node);
  return { world: a.world, x: a.x + 10_000_000, z: a.z };
}

const PARTY = { mode: 'classic', worlds: ['alpha', 'beta'], noMove: false, noLook: false, rounds: 3 };

// ---------------------------------------------------------------------------------------------------------------------

describe('rooms over REST + WebSocket', () => {
  it('refuses sockets without a valid token and banned players', async () => {
    const anon = await Socket.open(null);
    expect(await anon.next('error')).toEqual({ t: 'error', error: 'auth' });
    expect(await anon.closed()).toBe(4401);

    const bad = await Socket.open('x'.repeat(40));
    expect((await bad.next('error')).error).toBe('auth');

    const banned = await new Player('10.9.0.1').register();
    await h.services.repo.setBanned(banned.id, true, h.clock.now);
    const ws = await Socket.open(banned.token);
    expect(await ws.next('error')).toEqual({ t: 'error', error: 'banned' });
    expect(await ws.closed()).toBe(4403);
    const res = await banned.call('POST', '/api/rooms', { type: 'party', settings: PARTY });
    expect(res).toEqual({ status: 403, body: { error: 'banned' } });

    // Non-/ws upgrades are refused.
    await expect(
      new Promise((resolve, reject) => {
        const ws2 = new WebSocket(`ws://${base}/other`);
        ws2.once('open', resolve);
        ws2.once('error', reject);
      }),
    ).rejects.toThrow();
  });

  it('REST: create validates, GET returns the view or 404', async () => {
    const p = await new Player('10.9.0.2').register();
    expect((await p.call('POST', '/api/rooms', { type: 'solo', settings: PARTY })).status).toBe(400);
    expect((await p.call('POST', '/api/rooms', { type: 'party', settings: { ...PARTY, rounds: 4 } })).status).toBe(400);
    const anon = new Player('10.9.0.2');
    expect((await anon.call('POST', '/api/rooms', { type: 'party', settings: PARTY })).status).toBe(401);
    const created = await p.call<CreateRoomResponse>('POST', '/api/rooms', { type: 'party', settings: PARTY });
    expect(created.status).toBe(201);
    expect(created.body.code).toMatch(/^[A-HJ-NP-Z]{5}$/);
    const view = await anon.call<RoomView>('GET', `/api/rooms/${created.body.code.toLowerCase()}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ code: created.body.code, type: 'party', phase: 'lobby', capacity: 16, myGameId: null });
    expect(view.body.settings.timeLimit).toBe(120); // party default
    expect(view.body.players).toEqual([{ id: p.id, nickname: expect.any(String), host: true, connected: false, guessed: false, total: 0 }]);
    expect((await anon.call('GET', '/api/rooms/ZZZZZ')).status).toBe(404);
  });

  it('party of three: simultaneous rounds, a disconnect and a reconnect, game over, challenge link', async () => {
    const [a, b, c] = await Promise.all([1, 2, 3].map((i) => new Player(`10.1.0.${i}`).register()));
    const { body } = await a!.call<CreateRoomResponse>('POST', '/api/rooms', { type: 'party', settings: { ...PARTY, timeLimit: 0 } });
    const code = body.code;
    const wa = await Socket.open(a!.token);
    const wb = await Socket.open(b!.token);
    let wc = await Socket.open(c!.token);
    wa.send({ t: 'join', code });
    await wa.room((r) => r.players.length === 1 && r.players[0]!.connected);
    wb.send({ t: 'join', code });
    wc.send({ t: 'join', code: code.toLowerCase() });
    const lobbyView = await wa.room((r) => r.players.length === 3 && r.players.every((p) => p.connected));
    expect(lobbyView.players.map((p) => [p.id, p.host])).toEqual([
      [a!.id, true],
      [b!.id, false],
      [c!.id, false],
    ]);
    wb.send({ t: 'start' });
    expect((await wb.next('error')).error).toBe('not_host');
    wa.send({ t: 'ping' });
    await wa.next('pong');

    wa.send({ t: 'start' });
    const [sa, sb, sc] = await Promise.all([wa.next('started'), wb.next('started'), wc.next('started')]);
    expect(sa.challengeCode).toBe(sb.challengeCode);
    expect(new Set([sa.gameId, sb.gameId, sc.gameId]).size).toBe(3);
    const games = { a: sa.gameId, b: sb.gameId, c: sc.gameId };

    // Round 1 opens for everyone at the same instant.
    const [ra, rb, rc] = await Promise.all([wa.next('round'), wb.next('round'), wc.next('round')]);
    expect(ra).toEqual(rb);
    expect(ra).toEqual(rc);
    expect(ra).toMatchObject({ n: 1, deadline: null });
    const late = await new Player('10.1.0.9').register();
    const wl = await Socket.open(late.token);
    wl.send({ t: 'join', code });
    expect((await wl.next('error')).error).toBe('room_started');
    await wl.close();

    // REST sees the room game: roomCode, open round, node walk.
    const gv = await a!.call<GameView>('GET', `/api/games/${games.a}`);
    expect(gv.body).toMatchObject({ kind: 'party', roomCode: code, current: { n: 1, startedAt: ra.startedAt } });
    expect((await a!.call<PanoNode>('GET', `/api/games/${games.a}/nodes/${ra.node.key}`)).body.key).toBe(ra.node.key);
    expect((await a!.call('POST', `/api/games/${games.a}/rounds`)).status).toBe(403); // rooms open rounds

    // A and B guess (C still has the round open: nothing revealed); C drops out → the round closes without C.
    expect(await a!.guess(games.a, answerOf(ra.node))).toBe('pending');
    await wc.next('guessed', (m) => m.playerId === a!.id);
    expect((await a!.call<GameView>('GET', `/api/games/${games.a}`)).body).toMatchObject({ total: 0, results: [{ n: 1, pending: true, score: 0 }] });
    expect(await b!.guess(games.b, farGuess(ra.node))).toBe('pending');
    await wa.next('guessed', (m) => m.playerId === b!.id);
    expect(wa.has('roundResult')).toBe(false);
    await wc.close();
    const res1 = await wa.next('roundResult');
    expect(res1.n).toBe(1);
    expect(res1.answer).toEqual(answerOf(ra.node));
    expect(res1.nextAt).toBe(h.clock.now + 15_000);
    expect(Object.fromEntries(res1.results.map((r) => [r.playerId, r.score]))).toEqual({ [a!.id]: 5000, [b!.id]: 0, [c!.id]: 0 });
    const afterDrop = await wa.room((r) => r.phase === 'result');
    expect(afterDrop.players.find((p) => p.id === c!.id)).toMatchObject({ connected: false, total: 0 });
    expect(afterDrop.players.find((p) => p.id === a!.id)!.total).toBe(5000);
    // Closed for everyone: REST reveals it now.
    const revealed = (await a!.call<GameView>('GET', `/api/games/${games.a}`)).body;
    expect(revealed.total).toBe(5000);
    expect(revealed.results[0]).toMatchObject({ n: 1, score: 5000, answer: answerOf(ra.node) });
    expect(revealed.results[0]!.pending).toBeUndefined();

    // C comes back with the same token and gets the whole state.
    wc = await Socket.open(c!.token);
    wc.send({ t: 'join', code });
    expect((await wc.next('started')).gameId).toBe(games.c);
    expect((await wc.next('roundResult')).n).toBe(1);
    expect(await wc.room((r) => r.myGameId === games.c && r.phase === 'result')).toBeTruthy();
    await wa.room((r) => r.players.every((p) => p.connected));

    // Rounds 2 and 3: everyone guesses (the guess limiter is 2/s per player: move the fake clock).
    let totals = { a: 5000, b: 0, c: 0 };
    for (const n of [2, 3]) {
      h.clock.advance(1500);
      wa.send({ t: 'next' });
      const isN = (m: { n: number }): boolean => m.n === n;
      const [r2a, , r2c] = await Promise.all([wa.next('round', isN), wb.next('round', isN), wc.next('round', isN)]);
      expect(r2a.n).toBe(n);
      expect(r2c.n).toBe(n);
      const exact = answerOf(r2a.node);
      expect(await a!.guess(games.a, exact)).toBe('pending');
      expect(await b!.guess(games.b, null)).toBe('pending');
      expect(wa.has('roundResult', isN)).toBe(false);
      // C's guess is the last one: the round is over for everyone, so C gets the full result at once.
      expect(await c!.guess(games.c, exact)).toBe(5000);
      const result = await wb.next('roundResult', isN);
      expect(result.results).toHaveLength(3);
      const score = (id: string): number => result.results.find((r) => r.playerId === id)!.score;
      totals = { a: totals.a + score(a!.id), b: totals.b + score(b!.id), c: totals.c + score(c!.id) };
    }
    expect(totals).toEqual({ a: 15000, b: 0, c: 10000 });
    h.clock.advance(1500);
    wa.send({ t: 'next' });
    const over = await wb.next('gameOver');
    expect(over.challengeCode).toBe(sa.challengeCode);
    expect(over.reason).toBe('rounds');
    expect(over.standings.map((s) => [s.playerId, s.total])).toEqual([
      [a!.id, 15000],
      [c!.id, 10000],
      [b!.id, 0],
    ]);
    const lobbyAgain = await wc.room((r) => r.phase === 'over');
    expect(lobbyAgain).toMatchObject({ round: 0, challengeCode: sa.challengeCode, myGameId: null });

    // The room's challenge: finished games on the leaderboard, and a friend can now play the same rounds.
    const board = await a!.call<LeaderboardView>('GET', `/api/challenges/${sa.challengeCode}/leaderboard`);
    expect(board.body.entries.map((e) => [e.playerId, e.total, e.rounds])).toEqual([
      [a!.id, 15000, [5000, 5000, 5000]],
      [c!.id, 10000, [0, 5000, 5000]],
      [b!.id, 0, [0, 0, 0]],
    ]);
    const friend = await new Player('10.1.0.10').register();
    const fg = await friend.call<GameView>('POST', '/api/games', { kind: 'challenge', code: sa.challengeCode });
    expect(fg.status).toBe(200);
    expect(fg.body).toMatchObject({ kind: 'challenge', totalRounds: 3 });
    expect((await friend.call<ChallengeView>('GET', `/api/challenges/${sa.challengeCode}`)).body).toMatchObject({ kind: 'party', players: 3 });

    // Admin: the room is listed and can be closed.
    const admin = roomsAdminSource(h.services);
    expect(admin.liveCounts().sockets).toBeGreaterThanOrEqual(3);
    expect(admin.listRooms().find((r) => r.code === code)).toMatchObject({ type: 'party', phase: 'over' });
    expect(registeredAdminRoomsSource()).not.toBeNull();
    expect(await admin.closeRoom(code)).toBe(true);
    for (const ws of [wa, wb, wc]) expect((await ws.next('error')).error).toBe('room_closed');
    expect((await a!.call('GET', `/api/rooms/${code}`)).status).toBe(404);
    expect(await admin.closeRoom(code)).toBe(false);
    wa.send({ t: 'start' });
    expect((await wa.next('error')).error).toBe('not_found');
    await Promise.all([wa.close(), wb.close(), wc.close()]);
  });

  it('party: the host ends an untimed round; a marker sent in the countdown counts, the idle player times out', async () => {
    const [a, b, c] = await Promise.all([1, 2, 3].map((i) => new Player(`10.4.0.${i}`).register()));
    const { body } = await a!.call<CreateRoomResponse>('POST', '/api/rooms', { type: 'party', settings: { ...PARTY, timeLimit: 0 } });
    const sockets = await Promise.all([a, b, c].map((p) => Socket.open(p!.token)));
    const [wa, wb, wc] = sockets as [Socket, Socket, Socket];
    for (const ws of sockets) ws.send({ t: 'join', code: body.code });
    await wa.room((r) => r.players.length === 3 && r.players.every((p) => p.connected));
    wa.send({ t: 'start' });
    const [sa, sb] = await Promise.all([wa.next('started'), wb.next('started'), wc.next('started')]);
    const round = await wa.next('round');
    expect(round.deadline).toBeNull();
    expect(await a!.guess(sa.gameId, answerOf(round.node))).toBe('pending');

    wb.send({ t: 'endRound' });
    expect((await wb.next('error')).error).toBe('not_host');
    wa.send({ t: 'endRound' });
    const deadline = h.clock.now + 5000;
    for (const ws of sockets) expect(await ws.next('countdown')).toEqual({ t: 'countdown', deadline });
    // B's client submits the placed marker before the deadline; C does nothing.
    h.clock.advance(4700);
    expect(await b!.guess(sb.gameId, answerOf(round.node))).toBe('pending');
    expect(wa.has('roundResult')).toBe(false);
    h.clock.advance(300 + 2000);
    await roomRegistryOf(h.services).tickAll();
    const result = await wc.next('roundResult');
    expect(Object.fromEntries(result.results.map((r) => [r.playerId, r.score]))).toEqual({ [a!.id]: 5000, [b!.id]: 5000, [c!.id]: 0 });
    expect(result.results.find((r) => r.playerId === c!.id)!.guess).toBeNull();
    await Promise.all(sockets.map((ws) => ws.close()));
  });

  it('duel of two to KO with guesses over REST', async () => {
    const [d, e, f] = await Promise.all([1, 2, 3].map((i) => new Player(`10.2.0.${i}`).register()));
    const { body } = await d!.call<CreateRoomResponse>('POST', '/api/rooms', {
      type: 'duel',
      settings: { mode: 'classic', worlds: ['alpha'], noMove: false, noLook: false, timeLimit: 0, rounds: 30 },
    });
    const wd = await Socket.open(d!.token);
    const we = await Socket.open(e!.token);
    const wf = await Socket.open(f!.token);
    wd.send({ t: 'join', code: body.code });
    we.send({ t: 'join', code: body.code });
    await wd.room((r) => r.players.length === 2 && r.players.every((p) => p.connected));
    wf.send({ t: 'join', code: body.code });
    expect((await wf.next('error')).error).toBe('room_full');
    await wf.close();

    wd.send({ t: 'start' });
    const gd = (await wd.next('started')).gameId;
    const ge = (await we.next('started')).gameId;
    let round = await we.next('round');
    expect(round).toMatchObject({ n: 1, deadline: round.startedAt + 300_000, duel: { hp: { [d!.id]: 6000, [e!.id]: 6000 }, multiplier: 1 } });

    // Round 1: D exact, E far → E loses 5000.
    h.clock.advance(4000);
    expect(await d!.guess(gd, answerOf(round.node))).toBe('pending');
    const countdown = await we.next('countdown');
    expect(countdown.deadline).toBe(h.clock.now + 15_000);
    expect((await e!.call<GameView>('GET', `/api/games/${ge}`)).body.current!.deadline).toBe(countdown.deadline);
    expect(await e!.guess(ge, farGuess(round.node))).toBe(0);
    let result = await wd.next('roundResult');
    expect(result.duel).toEqual({ hp: { [d!.id]: 6000, [e!.id]: 1000 }, multiplier: 1, damage: { [d!.id]: 0, [e!.id]: 5000 } });
    expect((await we.room((r) => r.phase === 'result')).players.map((p) => p.hp)).toEqual([6000, 1000]);

    // Round 2: same again → KO.
    h.clock.advance(1500);
    wd.send({ t: 'next' });
    await wd.next('round', (m) => m.n === 1);
    round = await wd.next('round', (m) => m.n === 2);
    expect(round.duel!.hp[e!.id]).toBe(1000);
    await e!.guess(ge, null);
    await wd.next('countdown');
    await d!.guess(gd, answerOf(round.node));
    await we.next('roundResult', (m) => m.n === 1);
    result = await we.next('roundResult', (m) => m.n === 2);
    expect(result.duel!.hp).toEqual({ [d!.id]: 6000, [e!.id]: 0 });
    h.clock.advance(1500);
    wd.send({ t: 'next' });
    const over = await we.next('gameOver');
    expect(over.winner).toBe(d!.id);
    expect(over.reason).toBe('ko');
    expect(over.standings.map((s) => [s.playerId, s.hp, s.total])).toEqual([
      [d!.id, 6000, 10000],
      [e!.id, 0, 0],
    ]);
    // The duel's challenge keeps the 2 rounds actually played.
    const ch = await d!.call<ChallengeView>('GET', `/api/challenges/${over.challengeCode}`);
    expect(ch.body).toMatchObject({ kind: 'duel', players: 2 });
    expect(ch.body.settings.rounds).toBe(2);
    const gameD = await d!.call<GameView>('GET', `/api/games/${gd}`);
    expect(gameD.body).toMatchObject({ finished: true, total: 10000, totalRounds: 2 });
    await Promise.all([wd.close(), we.close()]);
  });

  it('a normal room becomes a duel in the lobby (one "Create room" in the menu) and back', async () => {
    const [d, e, f] = await Promise.all([1, 2, 3].map((i) => new Player(`10.2.1.${i}`).register()));
    const { body } = await d!.call<CreateRoomResponse>('POST', '/api/rooms', { type: 'party', settings: PARTY });
    const wd = await Socket.open(d!.token);
    const we = await Socket.open(e!.token);
    const wf = await Socket.open(f!.token);
    for (const ws of [wd, we, wf]) ws.send({ t: 'join', code: body.code });
    await wd.room((r) => r.type === 'party' && r.players.length === 3 && r.players.every((p) => p.connected));

    // Three players do not fit a duel: refused, the room stays normal.
    const duelSettings = { mode: 'classic', worlds: ['alpha'], noMove: false, noLook: false, timeLimit: 0, rounds: 30 };
    wd.send({ t: 'settings', type: 'duel', settings: duelSettings });
    expect((await wd.next('error')).error).toBe('room_full');
    expect((await d!.call<RoomView>('GET', `/api/rooms/${body.code}`)).body).toMatchObject({ type: 'party', capacity: 16 });
    // A guest cannot switch the type.
    we.send({ t: 'settings', type: 'duel', settings: duelSettings });
    expect((await we.next('error')).error).toBe('not_host');

    // The host kicks the third player and turns the room into a duel: everyone sees type, capacity and the cap.
    wd.send({ t: 'kick', playerId: f!.id });
    await wf.next('kicked');
    await wf.close();
    wd.send({ t: 'settings', type: 'duel', settings: duelSettings });
    const asDuel = await we.room((r) => r.type === 'duel');
    expect(asDuel).toMatchObject({ capacity: 2, settings: { rounds: 30, timeLimit: 0, worlds: ['alpha'] } });
    // ... and back to normal, then to a duel again (the lobby accepts any number of switches).
    wd.send({ t: 'settings', type: 'party', settings: { ...duelSettings, timeLimit: 120, rounds: 5 } });
    expect(await we.room((r) => r.type === 'party' && r.settings.rounds === 5)).toMatchObject({ capacity: 16, settings: { timeLimit: 120 } });
    wd.send({ t: 'settings', type: 'duel', settings: duelSettings });
    await we.room((r) => r.type === 'duel' && r.settings.rounds === 30);

    // The duel starts with exactly two players and plays as a duel (HP in the round message).
    wd.send({ t: 'start' });
    await we.next('started');
    const round = await we.next('round');
    expect(round).toMatchObject({ n: 1, duel: { hp: { [d!.id]: 6000, [e!.id]: 6000 }, multiplier: 1 } });
    // Leaving a running duel forfeits it at once.
    we.send({ t: 'leave' });
    const over = await wd.next('gameOver');
    expect(over).toMatchObject({ winner: d!.id, reason: 'forfeit' });
    await Promise.all([wd.close(), we.close()]);
  });

  it('a second socket of the same player replaces the first; switching rooms disconnects the old one', async () => {
    const p = await new Player('10.3.0.1').register();
    const q = await new Player('10.3.0.2').register();
    const r1 = (await p.call<CreateRoomResponse>('POST', '/api/rooms', { type: 'party', settings: PARTY })).body.code;
    const r2 = (await q.call<CreateRoomResponse>('POST', '/api/rooms', { type: 'party', settings: PARTY })).body.code;
    const tab1 = await Socket.open(p.token);
    tab1.send({ t: 'join', code: r1 });
    await tab1.room();
    const tab2 = await Socket.open(p.token);
    tab2.send({ t: 'join', code: r1 });
    expect((await tab1.next('error')).error).toBe('conflict');
    await tab2.room();
    tab1.send({ t: 'start' });
    expect((await tab1.next('error')).error).toBe('not_found'); // no longer attached
    await tab1.close();
    expect(roomRegistryOf(h.services).view(r1, p.id)!.players[0]!.connected).toBe(true); // the old socket's close is ignored

    tab2.send({ t: 'join', code: r2 });
    await tab2.room((r) => r.code === r2 && r.players.length === 2);
    const v1 = roomRegistryOf(h.services).view(r1, null)!;
    expect(v1.players[0]).toMatchObject({ id: p.id, connected: false });
    tab2.send({ t: 'leave' });
    await new Promise((r) => setTimeout(r, 50));
    expect(roomRegistryOf(h.services).view(r2, null)!.players.map((x) => x.id)).toEqual([q.id]);
    tab2.send({ t: 'bogus' });
    expect((await tab2.next('error')).error).toBe('bad_request');
    tab2.ws.send('not json');
    expect((await tab2.next('error')).error).toBe('bad_request');
    await tab2.close();
  });
});
