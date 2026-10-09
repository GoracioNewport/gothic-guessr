import { describe, expect, it } from 'vitest';
import { parseRoute, routePath, sameRoute } from '../src/router';

describe('parseRoute (SPEC 10.2 client routes)', () => {
  it('known routes', () => {
    expect(parseRoute('/')).toEqual({ name: 'menu' });
    expect(parseRoute('')).toEqual({ name: 'menu' });
    expect(parseRoute('/play')).toEqual({ name: 'play' });
    expect(parseRoute('/play/')).toEqual({ name: 'play' });
    expect(parseRoute('/daily')).toEqual({ name: 'daily', date: null });
    expect(parseRoute('/daily/2026-10-01')).toEqual({ name: 'daily', date: '2026-10-01' });
    expect(parseRoute('/c/k7m2p9qa')).toEqual({ name: 'challenge', code: 'k7m2p9qa' });
    expect(parseRoute('/c/daily-2026-10-07')).toEqual({ name: 'challenge', code: 'daily-2026-10-07' });
    expect(parseRoute('/r/abcde')).toEqual({ name: 'room', code: 'ABCDE' });
  });

  it('drops queries and fragments (stage-2 ?seed= links land on the page without them)', () => {
    expect(parseRoute('/?seed=42&mode=classic')).toEqual({ name: 'menu' });
    expect(parseRoute('/play?seed=7#x')).toEqual({ name: 'play' });
  });

  it('unknown or malformed paths are null', () => {
    for (const p of ['/admin', '/c', '/c/', '/c/a/b', '/daily/yesterday', '/r/AB-CD', '/x/y', '/c/%E0%A4%A', '/c/a b']) {
      expect(parseRoute(p)).toBeNull();
    }
  });
});

describe('routePath', () => {
  it('round-trips every route', () => {
    for (const p of ['/', '/play', '/daily', '/daily/2026-01-31', '/c/abc_DEF-1', '/r/ABCDE']) {
      expect(routePath(parseRoute(p)!)).toBe(p);
    }
  });
  it('upper-cases room codes and compares routes by path', () => {
    expect(routePath({ name: 'room', code: 'xyzab' })).toBe('/r/XYZAB');
    expect(sameRoute({ name: 'daily', date: null }, parseRoute('/daily/')!)).toBe(true);
    expect(sameRoute({ name: 'play' }, { name: 'menu' })).toBe(false);
  });
});
