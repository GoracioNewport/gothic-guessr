/**
 * Security review (stage 3): rate limits, abuse and input validation over HTTP (`app.request`, no ports). Every test
 * here documents a CONFIRMED issue and fails until it is fixed.
 *
 *   1. With TRUST_PROXY the client IP is the FIRST X-Forwarded-For entry, which the client controls behind a proxy that
 *      appends (nginx `$proxy_add_x_forwarded_for`): the admin login limit (5 / 15 min per IP) and the player creation
 *      limit (10 / h per IP) are bypassed by rotating that entry.
 *   2. Room codes (24^5 ≈ 8M) can be enumerated through `GET /api/rooms/:code` with no rate limit; strangers can then
 *      join private lobbies (SPEC §10.1 "no matchmaking with strangers").
 *   3. The global room cap (2000) is reachable from a handful of IPs (players are 10/h per IP, rooms 10/10 min per
 *      player, nothing per IP): room creation is then refused for everyone.
 *   4. `POST /games {kind:'solo'}` has no limit (one challenge row each) and node lookups are limited per game only, so
 *      one token crawls 10 × N nodes/s with N solo games (SPEC §10.9: limits "per IP and per token").
 *   5. Nicknames made of invisible Hangul filler letters pass the rules, and a filler inside a word dodges the filter.
 *   6. Per-IP limits key on the full address (an IPv6 /64 is one subscriber with 2^64 addresses), and a RateLimiter's
 *      bucket map is unbounded: `prune` only drops refilled buckets, so with fresh keys it grows past `maxKeys` and
 *      every later `take` walks the whole map.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiError, GameView, PlayerView, PublicSettings, RoundView } from '../../shared/api';
import { adminPlugin } from '../../server/admin/plugin';
import { RateLimiter } from '../../server/core/ratelimit';
import { createRoomsPlugin } from '../../server/rooms';
import type { ServerPlugin } from '../../server/plugins';
import { Client, harness } from './helpers';
import type { Harness } from './helpers';

const SOLO: PublicSettings = { mode: 'mixed', worlds: ['alpha', 'beta'], noMove: false, noLook: false, timeLimit: 0, rounds: 5 };

let h: Harness | null = null;
let plugins: ServerPlugin[] = [];
afterEach(async () => {
  for (const p of plugins) await p.close?.();
  plugins = [];
  h?.close();
  h = null;
});

async function req(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const headers: Record<string, string> = { host: 'guessr.test', ...(init.headers ?? {}) };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await h!.app.request(path, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
}

describe('review: X-Forwarded-For with TRUST_PROXY', () => {
  it('admin login limit cannot be bypassed by rotating the first X-Forwarded-For entry', async () => {
    plugins = [adminPlugin({ rooms: () => null })];
    h = harness({ app: { plugins } }); // testConfig: trustProxy = true
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      // The proxy appends the real peer (198.51.100.7); the attacker controls everything before it.
      const xff = `203.0.113.${i}, 198.51.100.7`;
      statuses.push((await req('/api/admin/login', { method: 'POST', headers: { 'x-forwarded-for': xff }, body: { password: `guess-${i}` } })).status);
    }
    // Today: twelve 401s, never a 429.
    expect(statuses).toContain(429);
  });

  it('player creation limit cannot be bypassed by rotating the first X-Forwarded-For entry', async () => {
    h = harness();
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      statuses.push((await req('/api/players', { method: 'POST', headers: { 'x-forwarded-for': `203.0.113.${i}, 198.51.100.7` } })).status);
    }
    expect(statuses).toContain(429);
  });
});

describe('review: rooms', () => {
  it('rate-limits room code lookups (enumeration of 24^5 codes)', async () => {
    plugins = [createRoomsPlugin({ registerAdmin: false })];
    h = harness({ app: { plugins } });
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const statuses = new Set<number>();
    for (let i = 0; i < 300; i++) {
      let code = '';
      for (let k = 0; k < 5; k++) code += alphabet[(i * 7 + k * 13 + k * i) % alphabet.length];
      statuses.add((await req(`/api/rooms/${code}`, { headers: { 'x-forwarded-for': '10.7.7.7' } })).status);
    }
    // Today only 404 (and 200 on a hit): 300 guesses per instant from one IP, no 429.
    expect(statuses.has(429)).toBe(true);
  });

  it('a few IPs cannot exhaust the global room cap for everyone', async () => {
    plugins = [createRoomsPlugin({ registerAdmin: false })];
    h = harness({ app: { plugins } });
    // 20 addresses (or 4 over 30 min): 10 players each, 10 rooms per player = 2000 rooms = MAX_ROOMS.
    for (let ip = 0; ip < 20; ip++) {
      for (let p = 0; p < 10; p++) {
        const c = new Client(h.app, `10.20.${ip}.1`);
        await c.register();
        for (let r = 0; r < 10; r++) {
          const res = await c.call('POST', '/api/rooms', { type: 'party', settings: SOLO });
          if (res.status !== 201) break;
        }
      }
    }
    const honest = new Client(h.app, '192.0.2.10');
    await honest.register();
    const res = await honest.call<ApiError>('POST', '/api/rooms', { type: 'party', settings: SOLO });
    // Today: 429 rate_limited "too many rooms" for a first-time player on a fresh IP.
    expect(res.status).toBe(201);
  }, 60_000);
});

describe('review: solo games and node lookups', () => {
  it('limits solo game creation per token', async () => {
    h = harness();
    const c = new Client(h.app, '10.30.0.1');
    await c.register();
    const statuses = new Set<number>();
    for (let i = 0; i < 200; i++) statuses.add((await c.call('POST', '/api/games', { kind: 'solo', settings: SOLO })).status);
    // Today: 200 new challenges (and DB rows) in the same instant, all 201.
    expect(statuses.has(429)).toBe(true);
  });

  it('limits node lookups per token, not only per game', async () => {
    h = harness();
    const c = new Client(h.app, '10.30.0.2');
    await c.register();
    let ok = 0;
    for (let g = 0; g < 5; g++) {
      const game = (await c.call<GameView>('POST', '/api/games', { kind: 'solo', settings: SOLO })).body;
      const round = (await c.call<RoundView>('POST', `/api/games/${game.id}/rounds`)).body;
      for (let i = 0; i < 10; i++) {
        const res = await c.call('GET', `/api/games/${game.id}/nodes/${round.start.key}`);
        if (res.status === 200) ok++;
      }
    }
    // Today: 50 lookups in the same instant, all 200 (10/s per game × any number of games).
    expect(ok).toBeLessThanOrEqual(10);
  });
});

describe('review: nickname rules', () => {
  it.each([
    ['two Hangul fillers (U+3164)', 'ㅤㅤ'],
    ['choseong + jungseong fillers (U+115F U+1160)', 'ᅟᅠ'],
    ['halfwidth fillers (U+FFA0)', 'ﾠﾠ'],
  ])('refuses a blank-looking nickname: %s', async (_label, nickname) => {
    h = harness();
    const c = new Client(h.app, '10.40.0.1');
    await c.register();
    const res = await c.call<PlayerView | ApiError>('PATCH', '/api/me', { nickname });
    expect(res.status).toBe(400);
  });

  it('a filler letter inside a word does not dodge the profanity filter', async () => {
    h = harness();
    const c = new Client(h.app, '10.40.0.2');
    await c.register();
    expect((await c.call('PATCH', '/api/me', { nickname: 'fuck' })).status).toBe(422);
    // Renders as "f uck"; today accepted (200).
    const res = await c.call('PATCH', '/api/me', { nickname: 'fㅤuck' });
    expect([400, 422]).toContain(res.status);
  });
});

describe('review: rate limiter keys and memory', () => {
  it('counts one IPv6 /64 as one address for player creation', async () => {
    h = harness();
    const statuses: number[] = [];
    for (let i = 1; i <= 15; i++) {
      statuses.push((await req('/api/players', { method: 'POST', headers: { 'x-forwarded-for': `2001:db8:1:2::${i.toString(16)}` } })).status);
    }
    // Today: 15 × 201 from one /64.
    expect(statuses).toContain(429);
  });

  it('keeps a limiter bounded by maxKeys when every bucket is fresh', () => {
    const limiter = new RateLimiter({ limit: 10, windowMs: 60 * 60_000 }, 100);
    for (let i = 0; i < 1000; i++) limiter.take(`ip:198.51.100.${i}`, 1_000);
    // Today: 1000 buckets kept (prune drops only refilled ones), and each take above 100 keys scans them all.
    expect(limiter.size).toBeLessThanOrEqual(100);
  });
});
