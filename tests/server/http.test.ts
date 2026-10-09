/**
 * HTTP integration through `app.request` (no sockets): auth, players, games, challenges, daily, hits, errors, limits.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiError,
  ChallengeView,
  GameSummaryView,
  GameView,
  LeaderboardView,
  PanoNode,
  PlayerView,
  PublicSettings,
  RoundResultView,
  RoundView,
} from '../../shared/api';
import { nodeByKey } from '../../server/core/worlds';
import { Client, harness } from './helpers';
import type { Harness } from './helpers';

const SOLO: PublicSettings = { mode: 'mixed', worlds: ['alpha', 'beta'], noMove: false, noLook: false, timeLimit: 0, rounds: 5 };

let h: Harness;
let alice: Client;

beforeEach(async () => {
  h = harness();
  alice = new Client(h.app, '10.0.0.1');
  await alice.register();
});
afterEach(() => h.close());

function answerFor(key: string): { world: string; x: number; z: number } {
  for (const w of h.services.worlds.values()) {
    const n = nodeByKey(w, key);
    if (n) return { world: w.slug, x: n.x, z: n.z };
  }
  throw new Error(key);
}

/** Every `"key": value` pair that would reveal a node's location before the guess. */
function leaks(body: unknown): string[] {
  const json = JSON.stringify(body);
  return [...json.matchAll(/"(x|y|z|wp|seed|dist|world|nodeId|id)"\s*:/g)].map((m) => m[1]!).filter((k) => k !== 'id');
}

describe('players and auth', () => {
  it('creates a player with a token and a default nickname', async () => {
    const res = await new Client(h.app).call<{ token: string; player: PlayerView }>('POST', '/api/players');
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.player).toMatchObject({ nickname: expect.stringMatching(/^Nameless Hero \d{4}$/), banned: false });
    expect(res.headers.get('cache-control')).toBe('no-store');
    // The token is stored hashed only.
    const row = h.services.repo.db.prepare('SELECT token_hash FROM players WHERE id = ?').get(res.body.player.id) as { token_hash: string };
    expect(row.token_hash).not.toBe(res.body.token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('401 auth without or with an unknown token', async () => {
    const anon = new Client(h.app);
    expect((await anon.call<ApiError>('GET', '/api/me')).body).toEqual({ error: 'auth' });
    anon.token = 'x'.repeat(43);
    const res = await anon.call<ApiError>('POST', '/api/games', { kind: 'solo', settings: SOLO });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('auth');
  });

  it('GET/PATCH /me with nickname validation', async () => {
    expect((await alice.call<PlayerView>('GET', '/api/me')).status).toBe(200);
    const ok = await alice.call<PlayerView>('PATCH', '/api/me', { nickname: '  Lord   Hagen ' });
    expect(ok.status).toBe(200);
    expect(ok.body.nickname).toBe('Lord Hagen');
    expect((await alice.call<PlayerView>('GET', '/api/me')).body.nickname).toBe('Lord Hagen');

    const format = await alice.call<ApiError>('PATCH', '/api/me', { nickname: 'x' });
    expect(format.status).toBe(400);
    expect(format.body.error).toBe('bad_request');
    const rude = await alice.call<ApiError>('PATCH', '/api/me', { nickname: 'Kurw4 Mać' });
    expect(rude.status).toBe(422);
    expect(rude.body.error).toBe('nickname_rejected');
    await h.services.repo.addBlockedWord('gronk', 0);
    expect((await alice.call<ApiError>('PATCH', '/api/me', { nickname: 'Gr0nk' })).body.error).toBe('nickname_rejected');
    expect((await alice.call<ApiError>('PATCH', '/api/me', 'not json')).body.error).toBe('bad_request');
  });

  it('limits player creation to 10/h per IP', async () => {
    const c = new Client(h.app, '10.9.9.9');
    for (let i = 0; i < 10; i++) expect((await c.call('POST', '/api/players')).status).toBe(201);
    const refused = await c.call<ApiError>('POST', '/api/players');
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe('rate_limited');
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await new Client(h.app, '10.9.9.8').call('POST', '/api/players')).status).toBe(201);
    h.clock.advance(6 * 60_000 + 1); // one token refills every 6 minutes
    expect((await c.call('POST', '/api/players')).status).toBe(201);
  });
});

describe('a full solo game over HTTP', () => {
  it('create → rounds → nodes → guesses → summary, without leaking answers', async () => {
    const created = await alice.call<GameView>('POST', '/api/games', { kind: 'solo', settings: SOLO });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(leaks(created.body)).toEqual([]);

    for (let n = 1; n <= 5; n++) {
      const round = await alice.call<RoundView>('POST', `/api/games/${id}/rounds`);
      expect(round.status).toBe(200);
      expect(round.body.n).toBe(n);
      expect(leaks(round.body)).toEqual([]);
      const node = await alice.call<PanoNode>('GET', `/api/games/${id}/nodes/${round.body.start.key}`);
      expect(node.body).toEqual(round.body.start);
      const step = await alice.call<PanoNode>('GET', `/api/games/${id}/nodes/${round.body.start.links[0]!.key}`);
      expect(step.status).toBe(200);
      expect(leaks(step.body)).toEqual([]);

      const resumed = await alice.call<GameView>('GET', `/api/games/${id}`);
      expect(resumed.body.currentKey).toBe(step.body.key);
      expect(resumed.body.current?.n).toBe(n);
      expect(leaks({ ...resumed.body, results: [] })).toEqual([]);

      h.clock.advance(2000);
      const answer = answerFor(round.body.start.key);
      const guess = await alice.call<RoundResultView>('POST', `/api/games/${id}/guess`, { guess: answer });
      expect(guess.status).toBe(200);
      expect(guess.body).toMatchObject({ n, score: 5000, distanceM: 0, timeMs: 2000, answer });
      h.clock.advance(1000); // guess limiter: 2/s
    }

    const summary = await alice.call<GameSummaryView>('GET', `/api/games/${id}/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body.game).toMatchObject({ finished: true, total: 25000 });
    expect(summary.body.leaderboard.me).toMatchObject({ rank: 1, total: 25000, timeMs: 10000 });

    const challenge = await alice.call<ChallengeView>('GET', `/api/challenges/${summary.body.game.challengeCode}`);
    expect(challenge.body).toMatchObject({ kind: 'solo', players: 1, myGame: { id, finished: true, total: 25000 } });
    expect(leaks(challenge.body)).toEqual([]);
  });

  it('error codes: unknown game, finished game, summary too early, bad bodies', async () => {
    expect((await alice.call<ApiError>('GET', '/api/games/nope')).status).toBe(404);
    expect((await alice.call<ApiError>('POST', '/api/games', { kind: 'solo', settings: { ...SOLO, worlds: ['mars'] } })).body.error).toBe('bad_request');
    expect((await alice.call<ApiError>('POST', '/api/games', { kind: 'party' })).body.error).toBe('bad_request');
    expect((await alice.call<ApiError>('POST', '/api/games', { kind: 'challenge', code: 'zzzzzzzz' })).status).toBe(404);
    const game = await alice.call<GameView>('POST', '/api/games', { kind: 'solo', settings: SOLO });
    expect((await alice.call<ApiError>('GET', `/api/games/${game.body.id}/summary`)).body.error).toBe('conflict');
    expect((await alice.call<ApiError>('POST', `/api/games/${game.body.id}/guess`, { guess: null })).body.error).toBe('round_over');
    await alice.call('POST', `/api/games/${game.body.id}/rounds`);
    expect((await alice.call<ApiError>('POST', `/api/games/${game.body.id}/guess`, {})).body.error).toBe('bad_request');
    expect((await alice.call<ApiError>('GET', '/api/nothing-here')).status).toBe(404);
    const huge = await alice.call<ApiError>('PATCH', '/api/me', { nickname: 'x'.repeat(40_000) });
    expect(huge.status).toBe(413);
    expect(huge.body.error).toBe('bad_request');
  });

  it('node lookups: 404 for unreachable keys, 10/s per game', async () => {
    const game = await alice.call<GameView>('POST', '/api/games', { kind: 'solo', settings: SOLO });
    const id = game.body.id;
    const round = await alice.call<RoundView>('POST', `/api/games/${id}/rounds`);
    expect((await alice.call<ApiError>('GET', `/api/games/${id}/nodes/zzzz00000000`)).status).toBe(404);
    let ok = 1; // the 404 above took a token
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const res = await alice.call('GET', `/api/games/${id}/nodes/${round.body.start.key}`);
      if (res.status === 200) ok++;
      if (res.status === 429) limited++;
    }
    expect(ok).toBe(10);
    expect(limited).toBe(3);
    h.clock.advance(1000);
    expect((await alice.call('GET', `/api/games/${id}/nodes/${round.body.start.key}`)).status).toBe(200);
  });

  it('guesses: 2/s per player', async () => {
    const game = await alice.call<GameView>('POST', '/api/games', { kind: 'solo', settings: SOLO });
    const id = game.body.id;
    await alice.call('POST', `/api/games/${id}/rounds`);
    expect((await alice.call('POST', `/api/games/${id}/guess`, { guess: null })).status).toBe(200);
    await alice.call('POST', `/api/games/${id}/rounds`);
    expect((await alice.call('POST', `/api/games/${id}/guess`, { guess: null })).status).toBe(200);
    await alice.call('POST', `/api/games/${id}/rounds`);
    expect((await alice.call('POST', `/api/games/${id}/guess`, { guess: null })).status).toBe(429);
  });
});

describe('challenge links and daily over HTTP', () => {
  it('a second player plays the link once; both appear on the leaderboard', async () => {
    const bob = new Client(h.app, '10.0.0.2');
    await bob.register();
    await bob.call('PATCH', '/api/me', { nickname: 'Bob' });
    const g = await alice.call<GameView>('POST', '/api/games', { kind: 'solo', settings: SOLO });
    const code = g.body.challengeCode;
    for (const [client, id] of [
      [alice, g.body.id],
      [bob, (await bob.call<GameView>('POST', '/api/games', { kind: 'challenge', code })).body.id],
    ] as const) {
      for (let n = 0; n < 5; n++) {
        await client.call('POST', `/api/games/${id}/rounds`);
        h.clock.advance(600);
        await client.call('POST', `/api/games/${id}/guess`, { guess: null });
      }
    }
    const again = await bob.call<ApiError>('POST', '/api/games', { kind: 'challenge', code });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already_played');
    const board = await bob.call<LeaderboardView>('GET', `/api/challenges/${code}/leaderboard?limit=1`);
    expect(board.body.entries).toHaveLength(1);
    expect(board.body.total).toBe(2);
    expect(board.body.me).toMatchObject({ nickname: 'Bob', rank: 2, me: true });
    const anon = await new Client(h.app).call<LeaderboardView>('GET', `/api/challenges/${code}/leaderboard`);
    expect(anon.body.me).toBeNull();
    expect(anon.body.entries.every((e) => !e.me)).toBe(true);
  });

  it('daily: today, past days, future 404, one attempt, share text with the request origin', async () => {
    const today = await alice.call<ChallengeView>('GET', '/api/daily');
    expect(today.body).toMatchObject({ code: 'daily-2026-10-07', date: '2026-10-07', myGame: null });
    expect((await alice.call('GET', '/api/daily/2026-10-07')).status).toBe(200);
    expect((await alice.call('GET', '/api/daily/2026-10-01')).status).toBe(404);
    expect((await alice.call('GET', '/api/daily/2026-10-08')).status).toBe(404);
    expect((await alice.call('GET', '/api/daily/garbage')).status).toBe(400);

    const game = await alice.call<GameView>('POST', '/api/games', { kind: 'daily' });
    expect(game.body).toMatchObject({ kind: 'daily', date: '2026-10-07' });
    const id = game.body.id;
    for (let n = 0; n < 5; n++) {
      const round = await alice.call<RoundView>('POST', `/api/games/${id}/rounds`);
      expect(round.body.deadline).toBe(round.body.startedAt + 120_000);
      h.clock.advance(1000);
      await alice.call('POST', `/api/games/${id}/guess`, { guess: answerFor(round.body.start.key) });
    }
    const summary = await alice.call<GameSummaryView>('GET', `/api/games/${id}/summary`);
    expect(summary.body.shareText).toBe('Gothic Guessr — Daily 2026-10-07\n25 000 / 25 000\n🟩🟩🟩🟩🟩\nhttp://guessr.test/daily');
    expect((await alice.call<ApiError>('POST', '/api/games', { kind: 'daily' })).body.error).toBe('already_played');
    expect((await alice.call<ChallengeView>('GET', '/api/daily')).body.myGame).toMatchObject({ id, finished: true, total: 25000 });
  });
});

describe('hits', () => {
  it('stores a normalised hit without IP and answers 204; 60/min per IP', async () => {
    const c = new Client(h.app, '10.7.7.7');
    const res = await c.call('POST', '/api/hits', { path: '/c/abc?x=1', referrer: 'https://reddit.com/r/worldofgothic', visitor: 'v-12345678', lang: 'pl' });
    expect(res.status).toBe(204);
    const row = h.services.repo.db.prepare('SELECT * FROM hits').get() as Record<string, unknown>;
    expect(row).toMatchObject({ path: '/c/abc', referrer_host: 'reddit.com', visitor: 'v-12345678', lang: 'pl', admin: 0, day: '2026-10-07' });
    expect(JSON.stringify(row)).not.toContain('10.7.7.7');
    expect((await c.call('POST', '/api/hits', { path: 'x', visitor: 'v-12345678' })).status).toBe(400);
    for (let i = 0; i < 58; i++) await c.call('POST', '/api/hits', { path: '/', referrer: '', visitor: 'v-12345678' });
    expect((await c.call('POST', '/api/hits', { path: '/', referrer: '', visitor: 'v-12345678' })).status).toBe(429);
  });
});

describe('plugins', () => {
  it('mounts plugin routes under /api with services', async () => {
    const { createApp } = await import('../../server/app');
    const app = createApp(h.services, {
      plugins: [{ name: 'probe', routes: (api, s) => api.get('/probe', (c) => c.json({ worlds: s.worlds.size })) }],
    });
    const res = await app.request('/api/probe');
    expect(await res.json()).toEqual({ worlds: 2 });
  });
});
