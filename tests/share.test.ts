import { describe, expect, it } from 'vitest';
import { msUntilNextUtcDay, utcDay } from '../src/pages/daily';
import { challengeLink, roundSquare, shareLines, squares } from '../src/play/share';
import { createHitTracker, randomVisitorId, visitorId, VISITOR_KEY } from '../src/net/hits';
import type { HitRequest } from '../shared/api';
import { dailyShareText, roundSquare as serverSquare } from '../server/core/share';

const r = (score: number, distanceM: number | null = 10, timedOut = false) => ({ score, distanceM, timedOut });

describe('result squares (SPEC 10.5)', () => {
  it('thresholds', () => {
    expect(roundSquare(r(5000))).toBe('🟩');
    expect(roundSquare(r(4000))).toBe('🟩');
    expect(roundSquare(r(3999))).toBe('🟨');
    expect(roundSquare(r(2000))).toBe('🟨');
    expect(roundSquare(r(1999))).toBe('🟧');
    expect(roundSquare(r(500))).toBe('🟧');
    expect(roundSquare(r(499))).toBe('🟥');
    expect(roundSquare(r(0, null))).toBe('⬛');
    expect(roundSquare(r(0, null, true))).toBe('⬛');
  });

  it('match the server share text for the same rounds', () => {
    const rounds = [r(4500), r(2500), r(800), r(100), r(0, null, true)];
    for (const x of rounds) expect(roundSquare(x)).toBe(serverSquare(x));
    const text = dailyShareText({ date: '2026-10-07', results: rounds, maxTotal: 25_000, origin: 'http://localhost:5173/' });
    expect(shareLines(text)).toEqual([
      'Gothic Guessr — Daily 2026-10-07',
      '7 900 / 25 000',
      squares(rounds),
      'http://localhost:5173/daily',
    ]);
    expect(squares(rounds)).toBe('🟩🟨🟧🟥⬛');
  });

  it('share text lines drop blanks and CRLF', () => {
    expect(shareLines('a\r\n\n b \n')).toEqual(['a', 'b']);
  });

  it('challenge links', () => {
    expect(challengeLink('k7m2', 'http://localhost:5173/')).toBe('http://localhost:5173/c/k7m2');
  });
});

describe('daily dates', () => {
  it('UTC day and time to the next one', () => {
    const t = Date.parse('2026-10-07T23:59:30Z');
    expect(utcDay(t)).toBe('2026-10-07');
    expect(msUntilNextUtcDay(t)).toBe(30_000);
    expect(msUntilNextUtcDay(Date.parse('2026-12-31T00:00:00Z'))).toBe(86_400_000);
  });
});

describe('hits (SPEC 10.4)', () => {
  it('visitor ids are random, url-safe and stored once', () => {
    expect(randomVisitorId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomVisitorId()).not.toBe(randomVisitorId());
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    const a = visitorId(storage);
    expect(data.get(VISITOR_KEY)).toBe(a);
    expect(visitorId(storage)).toBe(a);
  });

  it('sends one hit per route change, the external referrer only first', () => {
    const sent: { url: string; body: HitRequest }[] = [];
    const tracker = createHitTracker({ apiBase: '/api/', referrer: 'https://forum.example/thread', lang: () => 'de', send: (url, body) => sent.push({ url, body }) });
    tracker.track('/');
    tracker.track('/'); // same page again (replaceState) is not a new view
    tracker.track('/c/abc?x=1');
    tracker.track('/');
    expect(sent.map((s) => s.body.path)).toEqual(['/', '/c/abc', '/']);
    expect(sent[0]!.url).toBe('/api/hits');
    expect(sent[0]!.body.referrer).toBe('https://forum.example/thread');
    expect(sent[1]!.body.referrer).toBe('');
    expect(sent[0]!.body.lang).toBe('de');
    expect(sent[0]!.body.visitor).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('a throwing sender never breaks the app', () => {
    const tracker = createHitTracker({ referrer: '', send: () => {
      throw new Error('offline');
    } });
    expect(() => tracker.track('/play')).not.toThrow();
  });
});
