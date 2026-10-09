/**
 * Admin API (SPEC §10.9, §10.10) through `app.request`: auth on every route, login rate limit, sessions, statistics
 * over seeded data, the daily override `force` rule, leaderboard moderation (ban/hide/delete), the blocklist feeding
 * nickname validation, rooms via a fake registry, and the audit log.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AdminAuditPage,
  AdminBlocklist,
  AdminChallengeView,
  AdminDailyDetail,
  AdminDailyList,
  AdminNicknameCheck,
  AdminPlayerDetail,
  AdminPlayerList,
  AdminRoom,
  AdminRoomsView,
  AdminSession,
  AdminStats,
  ApiError,
  GameView,
  LeaderboardView,
  PublicSettings,
  RoundView,
} from '../../shared/api';
import { adminPlugin } from '../../server/admin/plugin';
import type { AdminRoomsSource } from '../../server/admin/rooms';
import { SESSION_COOKIE } from '../../server/admin/session';
import { nodeByKey } from '../../server/core/worlds';
import { Client, T0, harness } from './helpers';
import type { Harness } from './helpers';

const PASSWORD = 'test-admin-password';
/** A secret ADMIN_PATH (config.ts): the admin API lives under /api/<ADMIN_PATH>, /api/admin is just a 404. */
const ADMIN_PATH = 'ops-Panel_7x';
const API = `/api/${ADMIN_PATH}`;
const SOLO: PublicSettings = { mode: 'mixed', worlds: ['alpha', 'beta'], noMove: false, noLook: false, timeLimit: 0, rounds: 5 };
const DAY = 86_400_000;

class FakeRooms implements AdminRoomsSource {
  rooms: AdminRoom[] = [];
  sockets = 0;
  closed: string[] = [];
  liveCounts() {
    return { sockets: this.sockets, rooms: this.rooms.length };
  }
  listRooms() {
    return this.rooms;
  }
  closeRoom(code: string) {
    const before = this.rooms.length;
    this.rooms = this.rooms.filter((r) => r.code !== code);
    if (this.rooms.length === before) return false;
    this.closed.push(code);
    return true;
  }
}

interface Res<T> {
  status: number;
  body: T;
  headers: Headers;
}

/** Admin HTTP client with a one-cookie jar. */
class Admin {
  cookie: string | null = null;
  constructor(
    private readonly h: Harness,
    readonly ip = '10.9.9.9',
  ) {}

  async call<T = unknown>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res<T>> {
    const headers: Record<string, string> = { 'x-forwarded-for': this.ip, host: 'guessr.test', ...extra };
    if (this.cookie) headers.cookie = `${SESSION_COOKIE}=${this.cookie}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.h.app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
  }

  async login(password = PASSWORD): Promise<Res<AdminSession | ApiError>> {
    const res = await this.call<AdminSession | ApiError>('POST', `${API}/login`, { password });
    const set = res.headers.get('set-cookie');
    const m = set && new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(set);
    if (res.status === 200 && m) this.cookie = m[1]!;
    return res;
  }
}

let h: Harness;
let rooms: FakeRooms;
let admin: Admin;

beforeEach(async () => {
  rooms = new FakeRooms();
  h = harness({ config: { adminPath: ADMIN_PATH }, app: { plugins: [adminPlugin({ rooms: () => rooms })] } });
  admin = new Admin(h);
});
afterEach(() => h.close());

function answerFor(key: string): { world: string; x: number; z: number } {
  for (const w of h.services.worlds.values()) {
    const n = nodeByKey(w, key);
    if (n) return { world: w.slug, x: n.x, z: n.z };
  }
  throw new Error(key);
}

/** Play every round of a game: perfect guesses when `perfect`, give-ups otherwise. */
async function playOut(client: Client, id: string, perfect: boolean, rounds = 5): Promise<void> {
  for (let n = 0; n < rounds; n++) {
    const round = await client.call<RoundView>('POST', `/api/games/${id}/rounds`);
    h.clock.advance(700);
    const guess = perfect ? answerFor(round.body.start.key) : null;
    const res = await client.call('POST', `/api/games/${id}/guess`, { guess });
    if (res.status !== 200) throw new Error(`guess ${res.status} ${JSON.stringify(res.body)}`);
  }
}

async function player(ip: string, nickname?: string): Promise<{ client: Client; id: string }> {
  const client = new Client(h.app, ip);
  const id = await client.register();
  if (nickname) expect((await client.call('PATCH', '/api/me', { nickname })).status).toBe(200);
  return { client, id };
}

async function auditActions(): Promise<string[]> {
  return (await admin.call<AdminAuditPage>('GET', `${API}/audit?limit=500`)).body.entries.map((e) => e.action);
}

const ROUTES: [string, string][] = [
  ['GET', `${API}/session`],
  ['POST', `${API}/logout`],
  ['GET', `${API}/stats`],
  ['GET', `${API}/daily`],
  ['GET', `${API}/daily/2026-10-07`],
  ['PUT', `${API}/daily/2026-10-08`],
  ['DELETE', `${API}/daily/2026-10-08`],
  ['GET', `${API}/challenges/abc`],
  ['POST', `${API}/games/x/hide`],
  ['DELETE', `${API}/games/x`],
  ['GET', `${API}/players`],
  ['GET', `${API}/players/x`],
  ['POST', `${API}/players/x/ban`],
  ['POST', `${API}/players/x/reset-nickname`],
  ['GET', `${API}/rooms`],
  ['POST', `${API}/rooms/ABCDE/close`],
  ['GET', `${API}/blocklist`],
  ['POST', `${API}/blocklist`],
  ['DELETE', `${API}/blocklist/foo`],
  ['GET', `${API}/blocklist/check?nickname=x`],
  ['GET', `${API}/audit`],
  ['GET', `${API}/no-such-route`],
];

describe('admin auth', () => {
  it('every route needs the session cookie', async () => {
    for (const [method, path] of ROUTES) {
      const res = await admin.call<ApiError>(method, path, method === 'GET' ? undefined : {});
      expect([method, path, res.status, res.body.error]).toEqual([method, path, 401, 'auth']);
    }
    admin.cookie = 'v1.9999999999999.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    for (const [method, path] of ROUTES) {
      expect((await admin.call(method, path, method === 'GET' ? undefined : {})).status).toBe(401);
    }
  });

  it('a wrong password is refused and audited; the right one sets a strict HttpOnly cookie', async () => {
    const wrong = await admin.login('nope-nope-nope');
    expect(wrong.status).toBe(401);
    expect((wrong.body as ApiError).error).toBe('auth');
    expect(wrong.headers.get('set-cookie')).toBeNull();
    expect((await admin.call('POST', `${API}/login`, {})).status).toBe(400);

    const ok = await admin.login();
    expect(ok.status).toBe(200);
    expect((ok.body as AdminSession).expiresAt).toBe(T0 + 12 * 3600_000);
    const cookie = ok.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(new RegExp(`Path=${API}(?:;|$)`));
    expect(cookie).toMatch(/Max-Age=43200/);
    expect(cookie).not.toContain(PASSWORD);
    expect((await admin.call<AdminSession>('GET', `${API}/session`)).status).toBe(200);
    expect(await auditActions()).toEqual(['login', 'login.failed']);
  });

  it('a tampered cookie fails; the session expires after 12 h; logout revokes it', async () => {
    await admin.login();
    const good = admin.cookie!;
    admin.cookie = good.slice(0, -2) + (good.endsWith('A') ? 'BB' : 'AA');
    expect((await admin.call('GET', `${API}/session`)).status).toBe(401);
    admin.cookie = good.replace(/^v1\.(\d+)/, (_m, exp: string) => `v1.${Number(exp) + 1000}`);
    expect((await admin.call('GET', `${API}/session`)).status).toBe(401);
    admin.cookie = good;
    h.clock.advance(12 * 3600_000 - 1);
    expect((await admin.call('GET', `${API}/session`)).status).toBe(200);
    h.clock.advance(1);
    expect((await admin.call('GET', `${API}/session`)).status).toBe(401);

    h.clock.advance(-1000);
    expect((await admin.call('POST', `${API}/logout`)).status).toBe(204);
    expect((await admin.call('GET', `${API}/session`)).status).toBe(401);
  });

  it('sessions are bound to the secrets: another password or secret does not accept the cookie', async () => {
    await admin.login();
    const other = harness({
      config: { adminPassword: 'another-password', adminPath: ADMIN_PATH },
      app: { plugins: [adminPlugin()] },
    });
    try {
      const res = await other.app.request(`${API}/session`, { headers: { cookie: `${SESSION_COOKIE}=${admin.cookie}` } });
      expect(res.status).toBe(401);
    } finally {
      other.close();
    }
  });

  it('login is limited to 5 attempts per 15 min per IP, even with the right password', async () => {
    for (let i = 0; i < 5; i++) expect((await admin.login('wrong-password')).status).toBe(401);
    const limited = await admin.login();
    expect(limited.status).toBe(429);
    expect((limited.body as ApiError).error).toBe('rate_limited');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another IP is not affected.
    expect((await new Admin(h, '10.7.7.7').login()).status).toBe(200);
    // One attempt refills every 3 minutes.
    h.clock.advance(3 * 60_000);
    expect((await admin.login()).status).toBe(200);
  });

  it('lives only under /api/<ADMIN_PATH>: the default /api/admin is a plain 404, also with a valid session', async () => {
    for (const [method, path] of ROUTES) {
      const old = path.replace(API, '/api/admin');
      const res = await admin.call<ApiError>(method, old, method === 'GET' ? undefined : {});
      expect([method, old, res.status, res.body.error]).toEqual([method, old, 404, 'not_found']);
    }
    const res = await admin.call<ApiError>('POST', '/api/admin/login', { password: PASSWORD });
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
    await admin.login();
    expect((await admin.call('GET', '/api/admin/session')).status).toBe(404);
    expect((await admin.call('GET', `${API}/session`)).status).toBe(200);
    // Logout clears the cookie on the same Path it was set on.
    const out = await admin.call('POST', `${API}/logout`);
    expect(out.headers.get('set-cookie')).toMatch(new RegExp(`Path=${API}(?:;|$)`));
  });

  it('refuses cross-origin writes', async () => {
    await admin.login();
    const res = await admin.call<ApiError>('POST', `${API}/blocklist`, { word: 'gorgon' }, { origin: 'http://evil.test' });
    expect(res.status).toBe(403);
    const same = await admin.call('POST', `${API}/blocklist`, { word: 'gorgon' }, { origin: 'http://guessr.test' });
    expect(same.status).toBe(200);
  });
});

describe('admin statistics', () => {
  it('aggregates page views, visitors, players, games by kind, rooms and daily players per day', async () => {
    const hit = (ip: string, visitor: string, path: string, referrer = ''): Promise<unknown> =>
      new Client(h.app, ip).call('POST', '/api/hits', { path, visitor, referrer });

    // Day 1 (2026-10-05): 3 views by 2 visitors, 1 admin view (ignored), 1 player with a finished solo game.
    h.clock.now = T0 - 2 * DAY;
    await hit('1.1.1.1', 'visitor-aaaa', '/', 'https://www.reddit.com/r/worldofgothic');
    await hit('1.1.1.1', 'visitor-aaaa', '/play');
    await hit('1.1.1.2', 'visitor-bbbb', '/', 'https://reddit.com/x');
    await hit('1.1.1.3', 'visitor-admin', `/${ADMIN_PATH}`);
    const a = await player('1.1.1.1');
    const g1 = await a.client.call<GameView>('POST', '/api/games', { kind: 'solo', settings: SOLO });
    await playOut(a.client, g1.body.id, true);
    await h.services.repo.logRoomCreated('ABCDE', 'party', a.id, h.clock.now);

    // Day 3 (2026-10-07 = today): 2 players; daily played by both (one finishes), a challenge game started.
    h.clock.now = T0;
    await hit('1.1.1.1', 'visitor-aaaa', '/daily', 'https://www.reddit.com/');
    await hit('1.1.1.4', 'visitor-cccc', '/c/abc');
    const b = await player('2.2.2.2');
    const c = await player('2.2.2.3');
    const d1 = await b.client.call<GameView>('POST', '/api/games', { kind: 'daily' });
    await playOut(b.client, d1.body.id, false);
    await c.client.call<GameView>('POST', '/api/games', { kind: 'daily' });
    const ch = await c.client.call<GameView>('POST', '/api/games', { kind: 'challenge', code: g1.body.challengeCode });
    await c.client.call('POST', `/api/games/${ch.body.id}/rounds`); // open round → in progress
    await h.services.repo.logRoomCreated('FGHJK', 'duel', b.id, h.clock.now);
    await h.services.repo.logRoomCreated('LMNPQ', 'party', c.id, h.clock.now);
    rooms.sockets = 3;
    rooms.rooms = [{ code: 'LMNPQ', type: 'party', phase: 'lobby', players: [], createdAt: T0, lastActivityAt: T0 }];

    await admin.login();
    const res = await admin.call<AdminStats>('GET', `${API}/stats?from=2026-10-05&to=2026-10-07`);
    expect(res.status).toBe(200);
    const s = res.body;
    expect(s.days.map((d) => d.date)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
    const [d5, d6, d7] = s.days;
    expect(d5).toMatchObject({ pageViews: 3, visitors: 2, newPlayers: 1, roomsCreated: 1, dailyPlayers: 0 });
    expect(d5!.gamesStarted).toEqual({ solo: 1, daily: 0, challenge: 0, party: 0, duel: 0 });
    expect(d5!.gamesFinished).toEqual({ solo: 1, daily: 0, challenge: 0, party: 0, duel: 0 });
    expect(d6).toMatchObject({ pageViews: 0, visitors: 0, newPlayers: 0, roomsCreated: 0, dailyPlayers: 0 });
    expect(d7).toMatchObject({ pageViews: 2, visitors: 2, newPlayers: 2, roomsCreated: 2, dailyPlayers: 2 });
    expect(d7!.gamesStarted).toEqual({ solo: 0, daily: 2, challenge: 1, party: 0, duel: 0 });
    expect(d7!.gamesFinished).toEqual({ solo: 0, daily: 1, challenge: 0, party: 0, duel: 0 });
    // Totals: unique visitors over the range (aaaa, bbbb, cccc), sums otherwise.
    expect(s.totals).toMatchObject({ pageViews: 5, visitors: 3, newPlayers: 3, roomsCreated: 3, dailyPlayers: 2 });
    expect(s.totals.gamesStarted).toEqual({ solo: 1, daily: 2, challenge: 1, party: 0, duel: 0 });
    expect(s.topReferrers).toEqual([
      { host: 'www.reddit.com', count: 2 },
      { host: 'reddit.com', count: 1 },
    ]);
    expect(s.topPaths[0]).toEqual({ path: '/', count: 2 });
    expect(s.topPaths.map((p) => p.path)).not.toContain(`/${ADMIN_PATH}`);
    // Live: sockets/rooms from the registry; games with a recently opened round (daily of c + challenge of c).
    expect(s.live).toEqual({ sockets: 3, rooms: 1, gamesInProgress: 1 });

    // Default range = the last 30 days ending today.
    const def = await admin.call<AdminStats>('GET', `${API}/stats`);
    expect(def.body).toMatchObject({ from: '2026-09-08', to: '2026-10-07' });
    expect(def.body.days).toHaveLength(30);
    expect((await admin.call('GET', `${API}/stats?from=2026-10-07&to=2026-10-01`)).status).toBe(400);
    expect((await admin.call('GET', `${API}/stats?from=2024-01-01&to=2026-10-01`)).status).toBe(400);
    expect((await admin.call('GET', `${API}/stats?from=bad`)).status).toBe(400);
  });

  it('without a rooms registry the live counts are zero and rooms are unavailable', async () => {
    const bare = harness({ config: { adminPath: ADMIN_PATH }, app: { plugins: [adminPlugin()] } });
    try {
      const a = new Admin(bare);
      await a.login();
      expect((await a.call<AdminStats>('GET', `${API}/stats`)).body.live).toEqual({ sockets: 0, rooms: 0, gamesInProgress: 0 });
      expect((await a.call<AdminRoomsView>('GET', `${API}/rooms`)).body).toEqual({ available: false, rooms: [] });
      expect((await a.call<ApiError>('POST', `${API}/rooms/ABCDE/close`)).status).toBe(404);
    } finally {
      bare.close();
    }
  });
});

describe('admin daily management', () => {
  const HARD: PublicSettings = { mode: 'hardcore', worlds: ['beta'], noMove: true, noLook: false, timeLimit: 60, rounds: 5 };

  it('lists days with settings, players and best score', async () => {
    const p = await player('3.3.3.3');
    const g = await p.client.call<GameView>('POST', '/api/games', { kind: 'daily' });
    await playOut(p.client, g.body.id, true);
    await admin.login();
    const list = await admin.call<AdminDailyList>('GET', `${API}/daily`);
    expect(list.body.today).toBe('2026-10-07');
    expect(list.body.days[0]!.date).toBe('2026-10-21');
    expect(list.body.days.at(-1)!.date).toBe('2026-09-07');
    const today = list.body.days.find((d) => d.date === '2026-10-07')!;
    expect(today).toMatchObject({ exists: true, players: 1, games: 1, best: 25000, overridden: false, when: 'today' });
    expect(today.settings).toMatchObject({ mode: 'mixed', timeLimit: 120 });
    expect(list.body.days.find((d) => d.date === '2026-10-08')).toMatchObject({ exists: false, players: 0, best: null, when: 'future' });
  });

  it('future days are overridden freely; a day with games needs force', async () => {
    await admin.login();
    const fut = await admin.call<AdminDailyDetail>('PUT', `${API}/daily/2026-10-09`, { settings: HARD });
    expect(fut.status).toBe(200);
    expect(fut.body.row).toMatchObject({ overridden: true, settings: { mode: 'hardcore', worlds: ['beta'], timeLimit: 60 } });
    expect((await admin.call('PUT', `${API}/daily/2026-10-09`, { settings: { ...HARD, mode: 'nope' } })).status).toBe(400);
    expect((await admin.call('PUT', `${API}/daily/not-a-date`, { settings: HARD })).status).toBe(400);

    // Today gets a game → overriding needs force.
    const p = await player('3.3.3.4');
    await p.client.call<GameView>('POST', '/api/games', { kind: 'daily' });
    const refused = await admin.call<ApiError>('PUT', `${API}/daily/2026-10-07`, { settings: HARD });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('conflict');
    expect((await admin.call<AdminDailyDetail>('GET', `${API}/daily/2026-10-07`)).body.row.overridden).toBe(false);
    const forced = await admin.call<AdminDailyDetail>('PUT', `${API}/daily/2026-10-07`, { settings: HARD, force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.row).toMatchObject({ overridden: true, games: 1 });
    expect(forced.body.challenge!.settings).toMatchObject({ mode: 'hardcore', worlds: ['beta'] });
    // Players see the new settings.
    expect((await p.client.call<{ settings: PublicSettings }>('GET', '/api/daily')).body.settings.mode).toBe('hardcore');

    // Clearing follows the same rule.
    expect((await admin.call('DELETE', `${API}/daily/2026-10-07`)).status).toBe(409);
    const cleared = await admin.call<AdminDailyDetail>('DELETE', `${API}/daily/2026-10-07?force=1`);
    expect(cleared.body.row).toMatchObject({ overridden: false, settings: { mode: 'mixed' } });
    expect((await admin.call<AdminDailyDetail>('DELETE', `${API}/daily/2026-10-09`)).body.row.overridden).toBe(false);

    const audit = (await admin.call<AdminAuditPage>('GET', `${API}/audit`)).body.entries;
    expect(audit.map((e) => `${e.action} ${e.target}`)).toEqual([
      'daily.clear 2026-10-09',
      'daily.clear 2026-10-07',
      'daily.override 2026-10-07',
      'daily.override 2026-10-09',
      'login admin',
    ]);
    expect(JSON.parse(audit[2]!.details!)).toMatchObject({ force: true, games: 1 });
  });
});

describe('leaderboard moderation', () => {
  async function twoFinished(): Promise<{ code: string; alice: Awaited<ReturnType<typeof player>>; bob: Awaited<ReturnType<typeof player>> }> {
    const alice = await player('4.4.4.1', 'Alice');
    const bob = await player('4.4.4.2', 'Bob');
    const g = await alice.client.call<GameView>('POST', '/api/games', { kind: 'solo', settings: SOLO });
    await playOut(alice.client, g.body.id, true);
    const gb = await bob.client.call<GameView>('POST', '/api/games', { kind: 'challenge', code: g.body.challengeCode });
    await playOut(bob.client, gb.body.id, false);
    return { code: g.body.challengeCode, alice, bob };
  }

  const board = async (code: string): Promise<string[]> =>
    (await new Client(h.app).call<LeaderboardView>('GET', `/api/challenges/${code}/leaderboard`)).body.entries.map((e) => e.nickname);

  it('a ban removes the player from public leaderboards (admin still sees the row); unban restores it', async () => {
    const { code, alice } = await twoFinished();
    expect(await board(code)).toEqual(['Alice', 'Bob']);
    await admin.login();
    const banned = await admin.call<AdminPlayerDetail>('POST', `${API}/players/${alice.id}/ban`, { banned: true, reason: 'cheating' });
    expect(banned.status).toBe(200);
    expect(banned.body.player.banned).toBe(true);
    expect(banned.body.bans[0]).toMatchObject({ action: 'ban', reason: 'cheating' });
    expect(await board(code)).toEqual(['Bob']);
    const mod = await admin.call<AdminChallengeView>('GET', `${API}/challenges/${code}`);
    expect(mod.body.entries.map((e) => [e.nickname, e.rank, e.banned])).toEqual([
      ['Alice', 0, true],
      ['Bob', 1, false],
    ]);
    // The banned player can still read their own profile (and play solo).
    expect((await alice.client.call<{ banned: boolean }>('GET', '/api/me')).body.banned).toBe(true);
    await admin.call('POST', `${API}/players/${alice.id}/ban`, { banned: false });
    expect(await board(code)).toEqual(['Alice', 'Bob']);
    expect((await admin.call('POST', `${API}/players/nobody/ban`, { banned: true })).status).toBe(404);
    expect((await admin.call('POST', `${API}/players/${alice.id}/ban`, { banned: 'yes' })).status).toBe(400);
  });

  it('hide/unhide and delete a leaderboard entry', async () => {
    const { code, alice, bob } = await twoFinished();
    await admin.login();
    const mod = await admin.call<AdminChallengeView>('GET', `${API}/challenges/${code}`);
    expect(mod.body).toMatchObject({ code, kind: 'solo', games: 2, inProgress: 0, createdBy: { id: alice.id, nickname: 'Alice' } });
    const aliceGame = mod.body.entries[0]!.gameId;
    const bobGame = mod.body.entries[1]!.gameId;
    expect(mod.body.entries[0]!.rounds).toEqual([5000, 5000, 5000, 5000, 5000]);

    const hidden = await admin.call<AdminChallengeView>('POST', `${API}/games/${aliceGame}/hide`, { hidden: true });
    expect(hidden.body.entries[0]).toMatchObject({ hidden: true, rank: 0 });
    expect(await board(code)).toEqual(['Bob']);
    await admin.call('POST', `${API}/games/${aliceGame}/hide`, { hidden: false });
    expect(await board(code)).toEqual(['Alice', 'Bob']);

    const del = await admin.call<AdminChallengeView>('DELETE', `${API}/games/${bobGame}`);
    expect(del.body.entries.map((e) => e.nickname)).toEqual(['Alice']);
    expect(await board(code)).toEqual(['Alice']);
    // Bob may play the link again.
    expect((await bob.client.call('POST', '/api/games', { kind: 'challenge', code })).status).toBe(200);
    expect((await admin.call('DELETE', `${API}/games/${bobGame}`)).status).toBe(404);
    expect((await admin.call('GET', `${API}/challenges/nope`)).status).toBe(404);

    expect((await auditActions()).slice(0, 3)).toEqual(['game.delete', 'game.unhide', 'game.hide']);
  });

  it('daily detail shows the day leaderboard for moderation', async () => {
    const p = await player('4.4.4.3', 'Dailyman');
    const g = await p.client.call<GameView>('POST', '/api/games', { kind: 'daily' });
    await playOut(p.client, g.body.id, true);
    await admin.login();
    const d = await admin.call<AdminDailyDetail>('GET', `${API}/daily/2026-10-07`);
    expect(d.body.challenge!.entries).toMatchObject([{ nickname: 'Dailyman', total: 25000, rank: 1 }]);
    expect((await admin.call<AdminDailyDetail>('GET', `${API}/daily/2026-10-01`)).body.challenge).toBeNull();
  });
});

describe('players', () => {
  it('search by nickname or id prefix, view games, reset nickname', async () => {
    const a = await player('5.5.5.1', 'Diego');
    await player('5.5.5.2', 'Lester');
    await player('5.5.5.3', 'diego_fan');
    const g = await a.client.call<GameView>('POST', '/api/games', { kind: 'solo', settings: SOLO });
    await playOut(a.client, g.body.id, true, 2);
    await admin.login();

    const all = await admin.call<AdminPlayerList>('GET', `${API}/players`);
    expect(all.body.total).toBe(3);
    const found = await admin.call<AdminPlayerList>('GET', `${API}/players?q=DIEGO`);
    expect(found.body.players.map((p) => p.nickname).sort()).toEqual(['Diego', 'diego_fan']);
    const byId = await admin.call<AdminPlayerList>('GET', `${API}/players?q=${a.id.slice(0, 6)}`);
    expect(byId.body.players.map((p) => p.id)).toContain(a.id);
    expect((await admin.call<AdminPlayerList>('GET', `${API}/players?q=%25`)).body.total).toBe(0);
    expect((await admin.call<AdminPlayerList>('GET', `${API}/players?limit=1`)).body.players).toHaveLength(1);
    expect((await admin.call('GET', `${API}/players?limit=0`)).status).toBe(400);

    const detail = await admin.call<AdminPlayerDetail>('GET', `${API}/players/${a.id}`);
    expect(detail.body.player).toMatchObject({ nickname: 'Diego', games: 1, banned: false });
    expect(detail.body.games[0]).toMatchObject({ kind: 'solo', rounds: 2, finishedAt: null });

    const reset = await admin.call<AdminPlayerDetail>('POST', `${API}/players/${a.id}/reset-nickname`);
    expect(reset.body.player.nickname).toMatch(/^Nameless Hero \d{4}$/);
    expect((await a.client.call<{ nickname: string }>('GET', '/api/me')).body.nickname).toBe(reset.body.player.nickname);
    const audit = (await admin.call<AdminAuditPage>('GET', `${API}/audit`)).body.entries[0]!;
    expect(audit).toMatchObject({ action: 'player.reset_nickname', target: a.id });
    expect(audit.details).toContain('Diego →');
    expect((await admin.call('GET', `${API}/players/nobody`)).status).toBe(404);
  });
});

describe('blocklist', () => {
  it('feeds the nickname filter (add → rejected, remove → accepted)', async () => {
    const p = await player('6.6.6.1');
    expect((await p.client.call('PATCH', '/api/me', { nickname: 'Gorgonzola' })).status).toBe(200);
    await admin.login();
    const added = await admin.call<AdminBlocklist>('POST', `${API}/blocklist`, { word: '  GORGON ' });
    expect(added.body.words.map((w) => w.word)).toEqual(['gorgon']);
    const rejected = await p.client.call<ApiError>('PATCH', '/api/me', { nickname: 'G0rg0n Lord' });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error).toBe('nickname_rejected');
    const check = await admin.call<AdminNicknameCheck>('GET', `${API}/blocklist/check?nickname=xGorgonx`);
    expect(check.body).toMatchObject({ result: 'blocked', match: 'gorgon' });
    expect((await admin.call<AdminNicknameCheck>('GET', `${API}/blocklist/check?nickname=Milten`)).body.result).toBe('ok');
    expect((await admin.call<AdminNicknameCheck>('GET', `${API}/blocklist/check?nickname=x`)).body.result).toBe('format');

    expect((await admin.call('POST', `${API}/blocklist`, { word: 'ab' })).status).toBe(400);
    expect((await admin.call('POST', `${API}/blocklist`, { word: 'two words' })).status).toBe(400);
    expect((await admin.call('POST', `${API}/blocklist`, { word: 'x'.repeat(41) })).status).toBe(400);
    expect((await admin.call('POST', `${API}/blocklist`, {})).status).toBe(400);

    const removed = await admin.call<AdminBlocklist>('DELETE', `${API}/blocklist/gorgon`);
    expect(removed.body.words).toEqual([]);
    expect((await admin.call('DELETE', `${API}/blocklist/gorgon`)).status).toBe(404);
    expect((await p.client.call('PATCH', '/api/me', { nickname: 'G0rg0n Lord' })).status).toBe(200);

    // Cyrillic words work too (URL-encoded on delete).
    await admin.call('POST', `${API}/blocklist`, { word: 'Мракорис' });
    expect((await p.client.call('PATCH', '/api/me', { nickname: 'мракорис123' })).status).toBe(422);
    expect((await admin.call('DELETE', `${API}/blocklist/${encodeURIComponent('мракорис')}`)).status).toBe(200);

    expect((await auditActions()).slice(0, 4)).toEqual(['blocklist.remove', 'blocklist.add', 'blocklist.remove', 'blocklist.add']);
  });
});

describe('rooms', () => {
  it('lists live rooms (most recent activity first) and closes one', async () => {
    rooms.rooms = [
      { code: 'AAAAA', type: 'party', phase: 'lobby', players: [{ id: 'p1', nickname: 'Xardas', connected: true }], createdAt: T0, lastActivityAt: T0 },
      { code: 'BBBBB', type: 'duel', phase: 'round', players: [], createdAt: T0, lastActivityAt: T0 + 5 },
    ];
    await admin.login();
    const list = await admin.call<AdminRoomsView>('GET', `${API}/rooms`);
    expect(list.body.available).toBe(true);
    expect(list.body.rooms.map((r) => r.code)).toEqual(['BBBBB', 'AAAAA']);
    const closed = await admin.call<AdminRoomsView>('POST', `${API}/rooms/AAAAA/close`);
    expect(closed.body.rooms.map((r) => r.code)).toEqual(['BBBBB']);
    expect(rooms.closed).toEqual(['AAAAA']);
    expect((await admin.call('POST', `${API}/rooms/ZZZZZ/close`)).status).toBe(404);
    expect((await auditActions())[0]).toBe('room.close');
  });
});

describe('audit log', () => {
  it('records every write, newest first, with keyset paging', async () => {
    await admin.login();
    for (const word of ['alpha', 'bravo', 'charlie', 'delta']) await admin.call('POST', `${API}/blocklist`, { word });
    const first = await admin.call<AdminAuditPage>('GET', `${API}/audit?limit=2`);
    expect(first.body.entries.map((e) => e.target)).toEqual(['delta', 'charlie']);
    expect(first.body.next).not.toBeNull();
    const second = await admin.call<AdminAuditPage>('GET', `${API}/audit?limit=2&before=${first.body.next}`);
    expect(second.body.entries.map((e) => e.target)).toEqual(['bravo', 'alpha']);
    const third = await admin.call<AdminAuditPage>('GET', `${API}/audit?limit=2&before=${second.body.next}`);
    expect(third.body.entries.map((e) => e.action)).toEqual(['login']);
    expect(third.body.next).toBeNull();
    // Reads do not write to the audit log; no IPs or secrets in it.
    await admin.call('GET', `${API}/stats`);
    const all = JSON.stringify((await admin.call<AdminAuditPage>('GET', `${API}/audit?limit=500`)).body);
    expect((await auditActions()).length).toBe(5);
    expect(all).not.toContain('10.9.9.9');
    expect(all).not.toContain(PASSWORD);
  });
});
