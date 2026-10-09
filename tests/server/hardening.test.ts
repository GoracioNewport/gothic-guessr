/**
 * Follow-ups to the stage-3 security review (review-*.test.ts hold the original findings): client address keys, the
 * bounded rate limiter, nickname edge cases, and what a room player sees before and after a room round closes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ChallengeView, GameView, LeaderboardView, PublicSettings } from '../../shared/api';
import { clientKey, forwardedClient, ipKey } from '../../server/core/ip';
import { checkNickname } from '../../server/core/nickname';
import { findProfanity } from '../../server/core/profanity';
import { RateLimiter } from '../../server/core/ratelimit';
import { Client, harness } from './helpers';
import type { Harness } from './helpers';

describe('client address keys', () => {
  it('takes the rightmost forwarded entry', () => {
    expect(forwardedClient('203.0.113.9, 198.51.100.7')).toBe('198.51.100.7');
    expect(forwardedClient(' 198.51.100.7 ')).toBe('198.51.100.7');
    expect(forwardedClient('1.2.3.4, ')).toBe('1.2.3.4');
    expect(forwardedClient('')).toBeNull();
    expect(forwardedClient(undefined)).toBeNull();
  });

  it('uses the header only behind a trusted proxy', () => {
    expect(clientKey('203.0.113.9, 198.51.100.7', '10.0.0.1', true)).toBe('198.51.100.7');
    expect(clientKey('203.0.113.9', '10.0.0.1', false)).toBe('10.0.0.1');
    expect(clientKey(undefined, '10.0.0.1', true)).toBe('10.0.0.1');
    expect(clientKey(undefined, undefined, true)).toBe('unknown');
  });

  it.each([
    ['198.51.100.7', '198.51.100.7'],
    ['198.51.100.7:4711', '198.51.100.7'],
    ['::ffff:198.51.100.7', '198.51.100.7'],
    ['::FFFF:c633:6407', '198.51.100.7'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['[2001:db8:1:2::f]:443', '2001:db8:1:2::/64'],
    ['fe80::1%en0', 'fe80:0:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['unknown', 'unknown'],
    ['not an address', 'not an address'],
  ])('ipKey(%s) = %s', (raw, key) => {
    expect(ipKey(raw)).toBe(key);
  });

  it('keeps different /64s apart', () => {
    expect(ipKey('2001:db8:1:2::1')).not.toBe(ipKey('2001:db8:1:3::1'));
  });
});

describe('rate limiter', () => {
  it('peek decides like take without spending a token', () => {
    const l = new RateLimiter({ limit: 2, windowMs: 1000 });
    expect(l.peek('k', 0).ok).toBe(true);
    expect(l.take('k', 0).ok).toBe(true);
    expect(l.take('k', 0).ok).toBe(true);
    expect(l.peek('k', 0)).toEqual({ ok: false, retryAfterMs: 500 });
    expect(l.peek('k', 500).ok).toBe(true);
    expect(l.size).toBe(1);
  });

  it('evicts the least recently used keys first, so an active key keeps its debt', () => {
    const l = new RateLimiter({ limit: 1, windowMs: 60_000 }, 10);
    expect(l.take('busy', 0).ok).toBe(true);
    for (let i = 0; i < 50; i++) {
      l.take(`other:${i}`, 1);
      expect(l.take('busy', 1).ok).toBe(false); // touched every time: never evicted
    }
    expect(l.size).toBeLessThanOrEqual(10);
  });
});

describe('nickname edge cases', () => {
  it('accepts names that need a few combining marks', () => {
    expect(checkNickname('Nguyễn Thị')).toMatchObject({ ok: true });
    expect(checkNickname('हिन्दी')).toMatchObject({ ok: true });
    expect(checkNickname('Jürgen')).toMatchObject({ ok: true });
  });

  it('refuses zalgo, zero-width joiners and fillers', () => {
    expect(checkNickname(`a${'́'.repeat(19)}b`)).toEqual({ ok: false, reason: 'format' });
    expect(checkNickname('ab‍cd')).toEqual({ ok: false, reason: 'format' });
    expect(checkNickname('abㅤcd')).toEqual({ ok: false, reason: 'format' });
  });

  it('the filter sees through invisible characters', () => {
    expect(findProfanity('fㅤuck')).not.toBeNull();
    expect(findProfanity('хㅤуй')).not.toBeNull();
    expect(findProfanity('f​uck')).not.toBeNull();
  });
});

const PARTY: PublicSettings = { mode: 'classic', worlds: ['alpha', 'beta'], noMove: false, noLook: false, timeLimit: 0, rounds: 3 };

let h: Harness | null = null;
afterEach(() => {
  h?.close();
  h = null;
});

describe('room results before and after the room round closes', () => {
  it('withholds the score in the game view and the challenge view, then reveals and lists everything', async () => {
    h = harness();
    const a = new Client(h.app, '10.70.0.1');
    const b = new Client(h.app, '10.70.0.2');
    const aId = await a.register();
    const bId = await b.register();
    const room = await h.services.games.createRoomGames({ type: 'party', settings: PARTY, roomCode: 'QWERT', hostId: aId, playerIds: [aId, bId] });
    const code = room.challengeCode;
    const ga = room.games[aId]!;
    const gb = room.games[bId]!;
    const opened = await h.services.games.openRoomRound(code, 1, { startedAt: h.clock.now, deadline: null });
    const answer = (await h.services.repo.listRounds(ga))[0]!;
    const world = h.services.worlds.get(answer.world)!;
    const node = world.manifest.nodes[world.idByKey.get(opened.node.key)!]!;

    h.clock.advance(1000);
    const res = await a.call<GameView['results'][number]>('POST', `/api/games/${ga}/guess`, { guess: { world: answer.world, x: node.x, z: node.z } });
    expect(res.body).toMatchObject({ n: 1, pending: true, score: 0, distanceM: null });
    expect(res.body.answer).toBeUndefined();
    const view = (await a.call<GameView>('GET', `/api/games/${ga}`)).body;
    expect(view.total).toBe(0);
    expect(view.results).toEqual([expect.objectContaining({ n: 1, pending: true, score: 0 })]);
    const challenge = (await a.call<ChallengeView>('GET', `/api/challenges/${code}`)).body;
    expect(challenge.myGame).toMatchObject({ id: ga, total: 0 });
    expect(challenge.players).toBe(0);

    // B guesses last: the round is over for everyone, B sees its result and A's view reveals A's.
    h.clock.advance(1000);
    const last = await b.call<GameView['results'][number]>('POST', `/api/games/${gb}/guess`, { guess: null });
    expect(last.body.pending).toBeUndefined();
    expect(last.body.answer).toEqual({ world: answer.world, x: node.x, z: node.z });
    const after = (await a.call<GameView>('GET', `/api/games/${ga}`)).body;
    expect(after.total).toBe(5000);
    expect(after.results[0]).toMatchObject({ score: 5000, answer: { world: answer.world } });
    expect((await a.call<ChallengeView>('GET', `/api/challenges/${code}`)).body.myGame?.total).toBe(5000);

    // Rounds 2-3 and the end of the room game: the leaderboard opens.
    await h.services.games.closeRoomRound(code, 1);
    for (const n of [2, 3]) {
      await h.services.games.openRoomRound(code, n, { startedAt: h.clock.now, deadline: null });
      await h.services.games.closeRoomRound(code, n);
    }
    expect((await a.call<LeaderboardView>('GET', `/api/challenges/${code}/leaderboard`)).body.entries).toEqual([]);
    await h.services.games.finishRoomChallenge(code, 3);
    const board = (await a.call<LeaderboardView>('GET', `/api/challenges/${code}/leaderboard`)).body;
    expect(board.entries.map((e) => [e.playerId, e.total])).toEqual([
      [aId, 5000],
      [bId, 0],
    ]);
    expect((await a.call<ChallengeView>('GET', `/api/challenges/${code}`)).body.players).toBe(2);
  });

  it('solo results are never pending', async () => {
    h = harness();
    const c = new Client(h.app, '10.70.0.3');
    await c.register();
    const game = (await c.call<GameView>('POST', '/api/games', { kind: 'solo', settings: { ...PARTY, rounds: 3, mode: 'mixed' } })).body;
    await c.call('POST', `/api/games/${game.id}/rounds`);
    const res = await c.call<GameView['results'][number]>('POST', `/api/games/${game.id}/guess`, { guess: null });
    expect(res.body.pending).toBeUndefined();
    expect(res.body.answer).toBeDefined();
  });
});

describe('WebSocket hub limits', () => {
  it('evicts the oldest socket past the per-player cap and counts unknown room codes per address', async () => {
    const { serve } = await import('@hono/node-server');
    const { WebSocket } = await import('ws');
    const { createRoomsPlugin } = await import('../../server/rooms');
    const { MAX_SOCKETS_PER_PLAYER, CLOSE_REPLACED } = await import('../../server/rooms/hub');
    const plugin = createRoomsPlugin({ heartbeatMs: 60_000, registerAdmin: false });
    h = harness({ app: { plugins: [plugin] } });
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: h!.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
    });
    plugin.attach!(server, h.services);
    const port = (server.address() as { port: number }).port;
    const sockets: InstanceType<typeof WebSocket>[] = [];
    const open = (token: string) =>
      new Promise<{ ws: InstanceType<typeof WebSocket>; inbox: { t: string; error?: string }[]; closed: Promise<number> }>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
        sockets.push(ws);
        const inbox: { t: string; error?: string }[] = [];
        ws.on('message', (d) => inbox.push(JSON.parse(d.toString()) as { t: string }));
        const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
        ws.once('open', () => resolve({ ws, inbox, closed }));
        ws.once('error', reject);
      });
    const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
    try {
      const p1 = new Client(h.app, '10.80.0.1');
      const p2 = new Client(h.app, '10.80.0.2');
      await p1.register();
      await p2.register();

      const first = await open(p1.token!);
      for (let i = 0; i < MAX_SOCKETS_PER_PLAYER - 1; i++) await open(p1.token!);
      await settle();
      expect(first.inbox).toEqual([]);
      const newest = await open(p1.token!);
      expect(await first.closed).toBe(CLOSE_REPLACED);
      expect(first.inbox).toEqual([{ t: 'error', error: 'conflict' }]);

      // 30 misses per address (both players connect from 127.0.0.1), then every join is refused.
      const s1 = await open(p2.token!);
      const s2 = newest.ws;
      const errors: string[] = [];
      const codes = (i: number) => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[i % 24]!.repeat(5);
      for (let i = 0; i < 16; i++) {
        s1.ws.send(JSON.stringify({ t: 'join', code: codes(i) }));
        s2.send(JSON.stringify({ t: 'join', code: codes(i + 16) }));
      }
      await settle(300);
      for (const m of [...s1.inbox, ...newest.inbox]) if (m.t === 'error') errors.push(m.error!);
      expect(errors).toContain('rate_limited');
      expect(errors.filter((e) => e === 'not_found').length).toBeLessThanOrEqual(30);
      // REST lookups from the same address share the budget.
      const rest = await new Client(h.app, 'unknown').call('GET', '/api/rooms/ZZZZZ');
      expect([404, 429]).toContain(rest.status);
    } finally {
      for (const ws of sockets) ws.terminate();
      await plugin.close?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
