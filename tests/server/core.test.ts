import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normaliseHit, referrerHost } from '../../server/core/analytics';
import { ApiFailure, statusForCode } from '../../server/core/errors';
import { Emitter } from '../../server/core/events';
import { compareLeaderboard, rankRows } from '../../server/core/leaderboard';
import { KeyedMutex } from '../../server/core/mutex';
import { checkNickname, defaultNickname, normaliseNickname } from '../../server/core/nickname';
import { findProfanity, isClean } from '../../server/core/profanity';
import {
  CHALLENGE_CODE_LENGTH,
  CODE_ALPHABET,
  ROOM_ALPHABET,
  ROOM_CODE_LENGTH,
  challengeCode,
  dailySeed,
  randomString,
  roomCode,
  sha256Hex,
} from '../../server/core/random';
import { RateLimiter } from '../../server/core/ratelimit';
import { dailyCode, defaultDailySettings, isIsoDate, parseSettings, utcDate } from '../../server/core/settings';
import { dailyShareText, groupThousands, roundSquare } from '../../server/core/share';
import { reachable } from '../../server/core/games';
import { toPanoNode } from '../../server/core/worlds';
import { fixtureKey, fixtureRegistry } from './fixtures/world';

describe('profanity filter', () => {
  const blocked = [
    'fuck',
    'FuckYou',
    'f.u_c k',
    'fuuuuck',
    'ｆｕｃｋ', // fullwidth
    'fuсk', // Cyrillic с
    '5h1t',
    'sh!t',
    '@sshole',
    'Scheiße',
    'arschl0ch',
    'kurwa',
    'kurw4',
    'Ku-r-w-a',
    'chuj',
    'pierdolony',
    'хуй',
    'Х у й',
    'xyй', // Latin x, y + Cyrillic й
    'пи3да',
    'сyка', // Latin y
    'cyka', // all Latin look-alikes of сука
    '6лядь',
    'BLYAT',
    'ёбаный', // ё → е
    'заебал',
  ];
  for (const name of blocked) {
    it(`blocks ${JSON.stringify(name)}`, () => expect(findProfanity(name)).not.toBeNull());
  }

  const clean = [
    'Wanderer0427',
    'Безымянный герой 0427',
    'Namenloser Held 0427',
    'Иван',
    'Łukasz',
    'Jürgen',
    'Class Act',
    'Grape',
    'Команда',
    'оскорбление',
    'Fukuoka',
    'Ignazio',
    'Torpedo',
    'Hui Min',
    'Huy',
    'Mitsubishi',
    'Dziewczyna',
    'Хачапури',
    'Небо',
    'Xardas',
    'Lee Sharky',
  ];
  for (const name of clean) {
    it(`allows ${JSON.stringify(name)}`, () => expect(findProfanity(name)).toBeNull());
  }

  it('applies the admin blocklist with the same normalisation', () => {
    expect(isClean('Gr0nk the Great')).toBe(true);
    expect(isClean('Gr0nk the Great', ['gronk'])).toBe(false);
    expect(isClean('Груша', ['груш'])).toBe(false);
    expect(isClean('ab', ['ab'])).toBe(true); // too short to match safely
  });
});

describe('nicknames', () => {
  it('normalises whitespace and NFC', () => {
    expect(normaliseNickname('  Lord   Hagen \t ')).toBe('Lord Hagen');
    expect(normaliseNickname('Jürgen')).toBe('Jürgen'.normalize('NFC'));
  });

  it('enforces length 2..24 in code points', () => {
    expect(checkNickname('A')).toEqual({ ok: false, reason: 'format' });
    expect(checkNickname('Ab')).toEqual({ ok: true, nickname: 'Ab' });
    expect(checkNickname('x'.repeat(24)).ok).toBe(true);
    expect(checkNickname('x'.repeat(25))).toEqual({ ok: false, reason: 'format' });
    expect(checkNickname('Ёжик_в-тумане.')).toEqual({ ok: true, nickname: 'Ёжик_в-тумане.' });
  });

  it('rejects other characters and separator-only names', () => {
    for (const bad of ['Diego!', 'a<b>', 'smile😀', '___', ' . ', 42, null, '']) {
      expect(checkNickname(bad)).toEqual({ ok: false, reason: 'format' });
    }
  });

  it('rejects offensive names as blocked (not format)', () => {
    expect(checkNickname('Mr F_u_c_k')).toEqual({ ok: false, reason: 'blocked' });
    expect(checkNickname('Gronk', ['gronk'])).toEqual({ ok: false, reason: 'blocked' });
  });

  it('default nickname is the hero title in the player language + 4 digits', () => {
    expect(defaultNickname(() => 7)).toBe('Nameless Hero 0007');
    expect(defaultNickname(() => 9999, 'en')).toBe('Nameless Hero 9999');
    expect(defaultNickname(() => 42, 'de')).toBe('Namenloser Held 0042');
    expect(defaultNickname(() => 42, 'pl')).toBe('Bezimienny 0042');
    expect(defaultNickname(() => 42, 'ru')).toBe('Безымянный герой 0042');
    for (const lang of ['en', 'de', 'pl', 'ru'] as const) {
      expect(checkNickname(defaultNickname(() => 9999, lang))).toMatchObject({ ok: true });
    }
    expect(checkNickname(defaultNickname(() => 1234)).ok).toBe(true);
  });
});

describe('codes and seeds', () => {
  it('generates codes from unambiguous alphabets', () => {
    for (let i = 0; i < 200; i++) {
      const c = challengeCode();
      expect(c).toHaveLength(CHALLENGE_CODE_LENGTH);
      expect([...c].every((ch) => CODE_ALPHABET.includes(ch))).toBe(true);
      const r = roomCode();
      expect(r).toMatch(new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_CODE_LENGTH}}$`));
      expect(r).not.toMatch(/[IO0-9]/);
    }
    expect(new Set(Array.from({ length: 500 }, () => randomString('ab', 32))).size).toBe(500);
  });

  it('daily seed = HMAC-SHA256(secret, "daily:" + date) truncated to 32 bits, deterministic', async () => {
    const secret = 'test-secret-abcdef';
    const expected = createHmac('sha256', secret).update('daily:2026-10-07').digest().readUInt32BE(0);
    expect(await dailySeed(secret, '2026-10-07')).toBe(expected || 1);
    expect(await dailySeed(secret, '2026-10-07')).toBe(await dailySeed(secret, '2026-10-07'));
    expect(await dailySeed(secret, '2026-10-08')).not.toBe(await dailySeed(secret, '2026-10-07'));
    expect(await dailySeed('other-secret-1234', '2026-10-07')).not.toBe(await dailySeed(secret, '2026-10-07'));
  });

  it('sha256Hex matches node:crypto', async () => {
    expect(await sha256Hex('token')).toBe(createHash('sha256').update('token').digest('hex'));
  });
});

describe('settings', () => {
  const all = ['alpha', 'beta', 'gamma'];

  it('normalises worlds to registry order and noLook → noMove', () => {
    const s = parseSettings({ mode: 'classic', worlds: ['gamma', 'alpha', 'alpha'], noLook: true, timeLimit: 60 }, all);
    expect(s).toEqual({ mode: 'classic', worlds: ['alpha', 'gamma'], noMove: true, noLook: true, timeLimit: 60, rounds: 5 });
  });

  it('forces rounds per kind', () => {
    const base = { mode: 'mixed', worlds: ['alpha'], timeLimit: 0 };
    expect(parseSettings({ ...base, rounds: 3 }, all, 'solo').rounds).toBe(3);
    expect(parseSettings(base, all, 'solo').rounds).toBe(5);
    expect(parseSettings({ ...base, rounds: 99 }, all, 'daily').rounds).toBe(5);
    expect(() => parseSettings({ ...base, rounds: 99 }, all, 'solo')).toThrow(ApiFailure);
    expect(parseSettings({ ...base, rounds: 10 }, all, 'party').rounds).toBe(10);
    expect(parseSettings(base, all, 'party').rounds).toBe(5);
    expect(parseSettings(base, all, 'duel').rounds).toBe(30);
    expect(() => parseSettings({ ...base, rounds: 7 }, all, 'party')).toThrow(ApiFailure);
  });

  it('rejects bad input with bad_request', () => {
    const bad: unknown[] = [
      null,
      [],
      { mode: 'insane', worlds: ['alpha'] },
      { mode: 'mixed', worlds: [] },
      { mode: 'mixed', worlds: ['nowhere'] },
      { mode: 'mixed', worlds: ['alpha'], timeLimit: 45 },
      { mode: 'mixed', worlds: ['alpha'], noMove: 'yes' },
    ];
    for (const raw of bad) {
      try {
        parseSettings(raw, all);
        expect.unreachable(JSON.stringify(raw));
      } catch (err) {
        expect((err as ApiFailure).code).toBe('bad_request');
      }
    }
  });

  it('daily defaults and dates', () => {
    expect(defaultDailySettings(all)).toEqual({ mode: 'mixed', worlds: all, noMove: false, noLook: false, timeLimit: 120, rounds: 5 });
    expect(utcDate(Date.UTC(2026, 9, 7, 23, 59))).toBe('2026-10-07');
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-1-01')).toBe(false);
    expect(dailyCode('2026-10-07')).toBe('daily-2026-10-07');
  });
});

describe('share text', () => {
  it('formats the Wordle-style text', () => {
    const r = (score: number, distanceM: number | null = 10, timedOut = false) => ({ score, distanceM, timedOut });
    const text = dailyShareText({
      date: '2026-10-07',
      results: [r(4500), r(4000), r(2500), r(100), r(0, null)],
      maxTotal: 25000,
      origin: 'https://g2.example/',
    });
    expect(text).toBe('Gothic Guessr — Daily 2026-10-07\n11 100 / 25 000\n🟩🟩🟨🟥⬛\nhttps://g2.example/daily');
    expect(roundSquare(r(700))).toBe('🟧');
    expect(roundSquare(r(0, null, true))).toBe('⬛');
    expect(roundSquare(r(0, 3000))).toBe('🟥');
    expect(groupThousands(1234567)).toBe('1 234 567');
  });
});

describe('leaderboard order', () => {
  it('total desc, time asc, finishedAt asc, id asc', () => {
    const rows = [
      { gameId: 'e', total: 100, timeMs: 5, finishedAt: 1 },
      { gameId: 'b', total: 200, timeMs: 9, finishedAt: 5 },
      { gameId: 'a', total: 200, timeMs: 9, finishedAt: 5 },
      { gameId: 'c', total: 200, timeMs: 9, finishedAt: 3 },
      { gameId: 'd', total: 200, timeMs: 1, finishedAt: 9 },
    ];
    expect(rankRows(rows).map((r) => `${r.rank}${r.gameId}`)).toEqual(['1d', '2c', '3a', '4b', '5e']);
    expect(compareLeaderboard(rows[0]!, rows[0]!)).toBe(0);
  });
});

describe('rate limiter', () => {
  it('allows a burst, refuses, then refills over the window', () => {
    const rl = new RateLimiter({ limit: 2, windowMs: 1000 });
    expect(rl.take('k', 0).ok).toBe(true);
    expect(rl.take('k', 0).ok).toBe(true);
    const refused = rl.take('k', 0);
    expect(refused).toEqual({ ok: false, retryAfterMs: 500 });
    expect(rl.take('other', 0).ok).toBe(true);
    expect(rl.take('k', 499).ok).toBe(false);
    expect(rl.take('k', 1000).ok).toBe(true);
    rl.prune(5000);
    expect(rl.size).toBe(0);
  });
});

describe('reach check', () => {
  const worlds = fixtureRegistry();
  const alpha = worlds.get('alpha')!;
  const nodes = alpha.manifest.nodes;
  // alpha grid is 5 columns: id = row * 5 + col. Start at id 6 (col 1, row 1).
  const start = fixtureKey('alpha', 6);
  const round = { key: start, seen: [start] };

  it('allows the start and its links, nothing further', () => {
    expect(reachable(nodes, alpha.idByKey, round, start, true)).toBe(true);
    for (const id of [1, 5, 7, 11]) expect(reachable(nodes, alpha.idByKey, round, fixtureKey('alpha', id), true)).toBe(true);
    for (const id of [0, 2, 8, 12, 20]) expect(reachable(nodes, alpha.idByKey, round, fixtureKey('alpha', id), true)).toBe(false);
    expect(reachable(nodes, alpha.idByKey, round, 'unknownkey', true)).toBe(false);
  });

  it('extends with every node seen', () => {
    const walked = { key: start, seen: [start, fixtureKey('alpha', 7)] };
    expect(reachable(nodes, alpha.idByKey, walked, fixtureKey('alpha', 8), true)).toBe(true);
    expect(reachable(nodes, alpha.idByKey, walked, fixtureKey('alpha', 9), true)).toBe(false);
  });

  it('No move: only the start', () => {
    expect(reachable(nodes, alpha.idByKey, round, start, false)).toBe(true);
    expect(reachable(nodes, alpha.idByKey, round, fixtureKey('alpha', 7), false)).toBe(false);
  });

  it('PanoNode exposes keys, yaw and pitch only', () => {
    const pano = toPanoNode(alpha, nodes[6]!);
    expect(Object.keys(pano).sort()).toEqual(['key', 'links']);
    expect(pano.links.map((l) => Object.keys(l).sort().join())).toEqual(Array(4).fill('key,pitch,yaw'));
    expect(toPanoNode(alpha, nodes[6]!, false).links).toEqual([]);
  });
});

describe('analytics normalisation', () => {
  it('keeps the path without query, the referrer host only, and flags admin pages', () => {
    const hit = normaliseHit(
      { path: '/c/abc?x=1#y', referrer: 'https://Forum.Example.org/t/123?q', visitor: 'visitor-123456', lang: 'de' },
      Date.UTC(2026, 9, 7, 1),
      'guessr.test',
    );
    expect(hit).toMatchObject({ path: '/c/abc', referrerHost: 'forum.example.org', visitor: 'visitor-123456', lang: 'de', admin: false, day: '2026-10-07' });
    expect(normaliseHit({ path: '/admin/stats', referrer: '', visitor: 'abcdefgh' }, 0, null).admin).toBe(true);
    // A secret ADMIN_PATH: its pages are admin, the old /admin and look-alike prefixes are not.
    expect(normaliseHit({ path: '/ops-x1/stats', visitor: 'abcdefgh' }, 0, null, 'ops-x1').admin).toBe(true);
    expect(normaliseHit({ path: '/ops-x1', visitor: 'abcdefgh' }, 0, null, 'ops-x1').admin).toBe(true);
    expect(normaliseHit({ path: '/ops-x12', visitor: 'abcdefgh' }, 0, null, 'ops-x1').admin).toBe(false);
    expect(normaliseHit({ path: '/admin', visitor: 'abcdefgh' }, 0, null, 'ops-x1').admin).toBe(false);
    expect(referrerHost('http://guessr.test/play', 'guessr.test')).toBe('');
    expect(referrerHost('javascript:alert(1)', null)).toBe('');
    expect(() => normaliseHit({ path: 'nope', visitor: 'abcdefgh' }, 0, null)).toThrow(ApiFailure);
    expect(() => normaliseHit({ path: '/', visitor: 'short' }, 0, null)).toThrow(ApiFailure);
    expect(() => normaliseHit({ path: '/', visitor: 'abcdefgh', lang: 'fr' }, 0, null)).toThrow(ApiFailure);
  });
});

describe('small utilities', () => {
  it('maps error codes to statuses', () => {
    expect(statusForCode('auth')).toBe(401);
    expect(statusForCode('already_played')).toBe(409);
    expect(statusForCode('rate_limited')).toBe(429);
    expect(statusForCode('nickname_rejected')).toBe(422);
  });

  it('emitter isolates listener errors and unsubscribes', () => {
    const errors: unknown[] = [];
    const e = new Emitter<{ ping: number }>((err) => errors.push(err));
    const got: number[] = [];
    const off = e.on('ping', (n) => got.push(n));
    e.on('ping', () => {
      throw new Error('boom');
    });
    e.emit('ping', 1);
    off();
    e.emit('ping', 2);
    expect(got).toEqual([1]);
    expect(errors).toHaveLength(2);
  });

  it('mutex serialises work per key', async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    const slow = (tag: string, ms: number) => () =>
      new Promise<void>((res) =>
        setTimeout(() => {
          log.push(tag);
          res();
        }, ms),
      );
    await Promise.all([m.run('a', slow('a1', 20)), m.run('a', slow('a2', 1)), m.run('b', slow('b1', 5))]);
    expect(log).toEqual(['b1', 'a1', 'a2']);
    expect(m.size).toBe(0);
  });
});
