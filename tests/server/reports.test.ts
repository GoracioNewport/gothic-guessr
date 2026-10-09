/**
 * Problem reports (server/core/reports.ts, server/routes/reports.ts): validation, rate limits, the location lookup
 * (only the caller's own game, only nodes they were shown), banned reporters flagged, the admin list/filter/counts,
 * status changes behind the admin session, and their audit entries.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AdminAuditPage,
  AdminReport,
  AdminReportCounts,
  AdminReportList,
  ApiError,
  GameView,
  PanoNode,
  PublicSettings,
  RoundView,
} from '../../shared/api';
import { adminPlugin } from '../../server/admin/plugin';
import { SESSION_COOKIE } from '../../server/admin/session';
import { REPORT_LIMITS, cleanText, parseReport } from '../../server/core/reports';
import { nodeByKey } from '../../server/core/worlds';
import { Client, harness } from './helpers';
import type { Harness } from './helpers';

const PASSWORD = 'test-admin-password';
const SOLO: PublicSettings = { mode: 'mixed', worlds: ['alpha', 'beta'], noMove: false, noLook: false, timeLimit: 0, rounds: 5 };

interface Res<T> {
  status: number;
  body: T;
  headers: Headers;
}

class Admin {
  cookie: string | null = null;
  constructor(private readonly h: Harness) {}

  async call<T = unknown>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res<T>> {
    const headers: Record<string, string> = { 'x-forwarded-for': '10.9.9.9', host: 'guessr.test', ...extra };
    if (this.cookie) headers.cookie = `${SESSION_COOKIE}=${this.cookie}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.h.app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
  }

  async login(): Promise<void> {
    const res = await this.call('POST', '/api/admin/login', { password: PASSWORD });
    const m = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(res.headers.get('set-cookie') ?? '');
    if (res.status !== 200 || !m) throw new Error(`login ${res.status}`);
    this.cookie = m[1]!;
  }
}

let h: Harness;
let admin: Admin;

beforeEach(async () => {
  h = harness({ app: { plugins: [adminPlugin({ rooms: () => null })] } });
  admin = new Admin(h);
  await admin.login();
});
afterEach(() => h.close());

async function player(ip = '10.0.0.1'): Promise<{ client: Client; id: string }> {
  const client = new Client(h.app, ip);
  const id = await client.register();
  return { client, id };
}

async function soloGame(client: Client): Promise<{ game: GameView; round: RoundView }> {
  const game = await client.call<GameView>('POST', '/api/games', { kind: 'solo', settings: SOLO });
  expect(game.status).toBe(201);
  const round = await client.call<RoundView>('POST', `/api/games/${game.body.id}/rounds`);
  expect(round.status).toBe(200);
  return { game: game.body, round: round.body };
}

async function list(query = ''): Promise<AdminReportList> {
  const res = await admin.call<AdminReportList>('GET', `/api/admin/reports${query}`);
  expect(res.status).toBe(200);
  return res.body;
}

describe('parseReport', () => {
  it('accepts the documented shapes and normalises them', () => {
    const r = parseReport({
      type: 'location',
      categories: ['visual', 'underground', 'visual'],
      game: { gameId: 'g1', round: 2 },
      context: { lang: 'ru', path: '/play?x=1#y', viewport: { w: 1280.4, h: 720 }, appVersion: 'abc123' },
    });
    expect(r).toEqual({
      type: 'location',
      text: '',
      categories: ['underground', 'visual'],
      game: { gameId: 'g1', round: 2 },
      lang: 'ru',
      path: '/play',
      viewport: '1280x720',
      appVersion: 'abc123',
    });
    expect(parseReport({ type: 'bug', text: '  The map\r\nis blank \u0007 ' }).text).toBe('The map\nis blank');
  });

  it.each([
    ['not an object', 'nope'],
    ['unknown type', { type: 'spam', text: 'x' }],
    ['text missing for a bug', { type: 'bug' }],
    ['blank text', { type: 'translation', text: '   ' }],
    ['location without a game needs text', { type: 'location', categories: ['floating'] }],
    ['text too long', { type: 'other', text: 'x'.repeat(1001) }],
    ['text not a string', { type: 'bug', text: 42 }],
    ['unknown category', { type: 'location', text: 'x', categories: ['ugly'] }],
    ['categories on a bug', { type: 'bug', text: 'x', categories: ['visual'] }],
    ['bad game id', { type: 'location', game: { gameId: '../x' } }],
    ['bad round', { type: 'location', game: { gameId: 'g', round: 0 } }],
    ['bad key', { type: 'location', game: { gameId: 'g', key: 'NOT A KEY' } }],
    ['bad lang', { type: 'bug', text: 'x', context: { lang: 'fr' } }],
    ['bad path', { type: 'bug', text: 'x', context: { path: 'http://evil' } }],
    ['bad viewport', { type: 'bug', text: 'x', context: { viewport: { w: -1, h: 3 } } }],
    ['bad version', { type: 'bug', text: 'x', context: { appVersion: '<script>' } }],
  ])('rejects %s', (_name, body) => {
    expect(() => parseReport(body)).toThrow();
  });

  it('allows exactly 1000 characters, counted as code points', () => {
    expect(parseReport({ type: 'bug', text: '𝔊'.repeat(1000) }).text).toHaveLength(2000);
    expect(cleanText('\u0000a\tb')).toBe('a\tb');
  });

  it('drops a game reference on non-location reports', () => {
    expect(parseReport({ type: 'bug', text: 'x', game: { gameId: 'g' } }).game).toBeNull();
  });
});

describe('POST /api/reports', () => {
  it('stores a text report with the client context; the player sees only 204', async () => {
    const { client, id } = await player();
    const res = await client.call('POST', '/api/reports', {
      type: 'translation',
      text: 'Missing text on the daily page',
      context: { lang: 'de', path: '/daily', viewport: { w: 1280, h: 720 }, appVersion: 'dev' },
    });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    const { reports, total } = await list();
    expect(total).toBe(1);
    expect(reports[0]).toMatchObject({
      type: 'translation',
      status: 'open',
      statusAt: null,
      text: 'Missing text on the daily page',
      player: { id, banned: false },
      flagged: false,
      location: null,
      lang: 'de',
      path: '/daily',
      viewport: '1280x720',
      appVersion: 'dev',
    });
    expect(reports[0]!.nickname).toBe(reports[0]!.player!.nickname);
  });

  it('needs a player', async () => {
    const anon = new Client(h.app);
    expect((await anon.call('POST', '/api/reports', { type: 'bug', text: 'x' })).status).toBe(401);
  });

  it('refuses invalid bodies and oversized ones', async () => {
    const { client } = await player();
    expect((await client.call<ApiError>('POST', '/api/reports', { type: 'bug' })).body.error).toBe('bad_request');
    const big = await client.call<ApiError>('POST', '/api/reports', { type: 'bug', text: 'x', pad: 'y'.repeat(9000) });
    expect(big.status).toBe(413);
    expect((await list()).total).toBe(0);
  });

  it('truncates the user agent', async () => {
    const { client } = await player();
    const res = await h.app.request('/api/reports', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${client.token}`,
        'content-type': 'application/json',
        'user-agent': `Mozilla/5.0 ${'x'.repeat(1000)}`,
        'x-forwarded-for': '10.0.0.1',
      },
      body: JSON.stringify({ type: 'bug', text: 'x' }),
    });
    expect(res.status).toBe(204);
    const ua = (await list()).reports[0]!.userAgent!;
    expect(ua.startsWith('Mozilla/5.0')).toBe(true);
    expect(ua.length).toBe(300);
  });

  it('limits reports per player (10/h) and per IP (30/h); refused reports cost nothing', async () => {
    const { client } = await player('10.1.1.1');
    for (let i = 0; i < REPORT_LIMITS.player.limit; i++) {
      expect((await client.call('POST', '/api/reports', { type: 'bug', text: `r${i}` })).status).toBe(204);
    }
    const refused = await client.call<ApiError>('POST', '/api/reports', { type: 'bug', text: 'one more' });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe('rate_limited');
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    // An invalid report does not use up the budget either.
    const other = await player('10.1.1.1');
    expect((await other.client.call('POST', '/api/reports', { type: 'bug' })).status).toBe(400);
    // The per-player budget refills over the hour.
    h.clock.advance(REPORT_LIMITS.player.windowMs / REPORT_LIMITS.player.limit + 1);
    expect((await client.call('POST', '/api/reports', { type: 'bug', text: 'later' })).status).toBe(204);

    // Per IP: many players behind one address.
    const ip = '10.2.2.2';
    let sent = 0;
    for (let p = 0; p < 4 && sent < REPORT_LIMITS.ip.limit; p++) {
      const { client: c } = await player(ip);
      for (let i = 0; i < REPORT_LIMITS.player.limit && sent < REPORT_LIMITS.ip.limit; i++, sent++) {
        expect((await c.call('POST', '/api/reports', { type: 'other', text: 'x' })).status).toBe(204);
      }
    }
    const fresh = await player(ip);
    expect((await fresh.client.call('POST', '/api/reports', { type: 'other', text: 'x' })).status).toBe(429);
    const elsewhere = await player('10.3.3.3');
    expect((await elsewhere.client.call('POST', '/api/reports', { type: 'other', text: 'x' })).status).toBe(204);
  });

  it('accepts reports from banned players but flags them', async () => {
    const { client, id } = await player();
    expect((await admin.call('POST', `/api/admin/players/${id}/ban`, { banned: true })).status).toBe(200);
    expect((await client.call('POST', '/api/reports', { type: 'bug', text: 'unfair' })).status).toBe(204);
    const [r] = (await list()).reports;
    expect(r!.flagged).toBe(true);
    expect(r!.player!.banned).toBe(true);
  });
});

describe('location reports', () => {
  it('resolve the node the player stands on in the open round (server-side position)', async () => {
    const { client } = await player();
    const { game, round } = await soloGame(client);
    const start = round.start;
    const next = start.links[0]!.key;
    expect((await client.call<PanoNode>('GET', `/api/games/${game.id}/nodes/${next}`)).status).toBe(200);
    const res = await client.call('POST', '/api/reports', { type: 'location', categories: ['underground'], game: { gameId: game.id } });
    expect(res.status).toBe(204);
    const [r] = (await list()).reports;
    const world = h.services.worlds.get(r!.location!.world)!;
    const node = nodeByKey(world, next)!;
    expect(r!.location).toEqual({
      gameId: game.id,
      round: 1,
      world: world.slug,
      key: next,
      nodeId: node.id,
      waypoint: node.wp,
      x: node.x,
      y: node.y,
      z: node.z,
      startKey: start.key,
      panoPath: `panos/${next}`,
    });
    expect(r!.categories).toEqual(['underground']);
    expect(r!.text).toBe('');
  });

  it('accept an explicit key only when the player was shown it in that round', async () => {
    const { client } = await player();
    const { game, round } = await soloGame(client);
    const neighbour = round.start.links[0]!.key;
    // A link of the start that was never fetched is not "shown" yet.
    const unseen = await client.call<ApiError>('POST', '/api/reports', { type: 'location', game: { gameId: game.id, key: neighbour } });
    expect(unseen.status).toBe(404);
    const seen = await client.call('POST', '/api/reports', { type: 'location', game: { gameId: game.id, key: round.start.key } });
    expect(seen.status).toBe(204);
    expect((await list()).reports[0]!.location!.key).toBe(round.start.key);
  });

  it('resolve "round n" to that round’s start node (summary) and refuse rounds never opened', async () => {
    const { client } = await player();
    const { game, round } = await soloGame(client);
    await client.call('GET', `/api/games/${game.id}/nodes/${round.start.links[0]!.key}`);
    await client.call('POST', `/api/games/${game.id}/guess`, { guess: null });
    expect((await client.call('POST', '/api/reports', { type: 'location', game: { gameId: game.id, round: 1 } })).status).toBe(204);
    expect((await list()).reports[0]!.location).toMatchObject({ round: 1, key: round.start.key, startKey: round.start.key });
    const future = await client.call<ApiError>('POST', '/api/reports', { type: 'location', game: { gameId: game.id, round: 2 } });
    expect(future.status).toBe(404);
  });

  it('refuse another player’s game the same way as an unknown one', async () => {
    const owner = await player('10.0.0.1');
    const { game } = await soloGame(owner.client);
    const other = await player('10.0.0.2');
    const theirs = await other.client.call<ApiError>('POST', '/api/reports', { type: 'location', game: { gameId: game.id } });
    const unknown = await other.client.call<ApiError>('POST', '/api/reports', { type: 'location', game: { gameId: 'nope' } });
    expect(theirs.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(theirs.body).toEqual(unknown.body);
    expect((await list()).total).toBe(0);
  });

  it('can be filtered by world and type', async () => {
    const { client } = await player();
    const { game } = await soloGame(client);
    await client.call('POST', '/api/reports', { type: 'location', game: { gameId: game.id } });
    await client.call('POST', '/api/reports', { type: 'bug', text: 'x' });
    const world = (await list()).reports.find((r) => r.location)!.location!.world;
    expect((await list(`?world=${world}`)).reports.map((r) => r.type)).toEqual(['location']);
    expect((await list('?type=bug')).total).toBe(1);
    expect((await list('?world=nowhere')).total).toBe(0);
  });
});

describe('admin', () => {
  it('requires the admin session on every report route', async () => {
    const anon = new Admin(h);
    for (const [method, path] of [
      ['GET', '/api/admin/reports'],
      ['GET', '/api/admin/reports/counts'],
      ['GET', '/api/admin/reports/1'],
      ['POST', '/api/admin/reports/1/status'],
    ] as const) {
      const res = await anon.call<ApiError>(method, path, method === 'POST' ? { status: 'resolved' } : undefined);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    // A player token is no admin session either.
    const { client } = await player();
    expect((await client.call('GET', '/api/admin/reports')).status).toBe(401);
  });

  it('changes status (resolve, ignore, reopen) with audit entries and counts', async () => {
    const { client } = await player();
    for (const type of ['bug', 'translation', 'other'] as const) {
      expect((await client.call('POST', '/api/reports', { type, text: type })).status).toBe(204);
    }
    let counts = (await admin.call<AdminReportCounts>('GET', '/api/admin/reports/counts')).body;
    expect(counts).toEqual({
      open: 3,
      byStatus: { open: 3, resolved: 0, ignored: 0 },
      openByType: { location: 0, translation: 1, bug: 1, other: 1 },
    });
    const [other, translation, bug] = (await list()).reports;
    expect([other!.type, translation!.type, bug!.type]).toEqual(['other', 'translation', 'bug']);

    h.clock.advance(1000);
    const resolved = await admin.call<AdminReport>('POST', `/api/admin/reports/${bug!.id}/status`, { status: 'resolved' });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ id: bug!.id, status: 'resolved', statusAt: h.clock.now });
    expect((await admin.call<AdminReport>('POST', `/api/admin/reports/${other!.id}/status`, { status: 'ignored' })).body.status).toBe('ignored');
    expect((await admin.call<AdminReport>('POST', `/api/admin/reports/${bug!.id}/status`, { status: 'open' })).body.status).toBe('open');
    // Same status again: no change, no audit entry.
    expect((await admin.call('POST', `/api/admin/reports/${bug!.id}/status`, { status: 'open' })).status).toBe(200);

    counts = (await admin.call<AdminReportCounts>('GET', '/api/admin/reports/counts')).body;
    expect(counts.byStatus).toEqual({ open: 2, resolved: 0, ignored: 1 });
    expect((await list('?status=open')).reports.map((r) => r.id)).toEqual([translation!.id, bug!.id]);
    expect((await list('?status=ignored')).reports.map((r) => r.id)).toEqual([other!.id]);

    const audit = (await admin.call<AdminAuditPage>('GET', '/api/admin/audit?limit=50')).body.entries.filter((e) => e.action.startsWith('report.'));
    expect(audit.map((e) => [e.action, e.target])).toEqual([
      ['report.reopen', String(bug!.id)],
      ['report.ignore', String(other!.id)],
      ['report.resolve', String(bug!.id)],
    ]);
    expect(audit[2]!.details).toBe('bug: open → resolved');
  });

  it('validates status changes and lookups', async () => {
    const { client } = await player();
    await client.call('POST', '/api/reports', { type: 'bug', text: 'x' });
    const [r] = (await list()).reports;
    expect((await admin.call('POST', `/api/admin/reports/${r!.id}/status`, { status: 'done' })).status).toBe(400);
    expect((await admin.call('POST', '/api/admin/reports/999/status', { status: 'resolved' })).status).toBe(404);
    expect((await admin.call('POST', '/api/admin/reports/abc/status', { status: 'resolved' })).status).toBe(400);
    expect((await admin.call('GET', '/api/admin/reports/999')).status).toBe(404);
    expect((await admin.call<AdminReport>('GET', `/api/admin/reports/${r!.id}`)).body.id).toBe(r!.id);
    expect((await admin.call('GET', '/api/admin/reports?status=weird')).status).toBe(400);
    expect((await admin.call('GET', '/api/admin/reports?type=weird')).status).toBe(400);
    // Cross-origin writes are refused like every admin write.
    const cross = await admin.call('POST', `/api/admin/reports/${r!.id}/status`, { status: 'resolved' }, { origin: 'https://evil.test' });
    expect(cross.status).toBe(403);
  });

  it('pages newest first with next/before', async () => {
    const { client } = await player();
    for (let i = 0; i < 5; i++) await client.call('POST', '/api/reports', { type: 'bug', text: `n${i}` });
    const first = await list('?limit=2');
    expect(first.reports.map((r) => r.text)).toEqual(['n4', 'n3']);
    expect(first.total).toBe(5);
    const second = await list(`?limit=2&before=${first.next}`);
    expect(second.reports.map((r) => r.text)).toEqual(['n2', 'n1']);
    const third = await list(`?limit=2&before=${second.next}`);
    expect(third.reports.map((r) => r.text)).toEqual(['n0']);
    expect(third.next).toBeNull();
  });
});
