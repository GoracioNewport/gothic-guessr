/**
 * The report dialog's request body (src/ui/report.ts) against the server's validation (server/core/reports.ts):
 * what the client sends for each type is what the server accepts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseReport } from '../server/core/reports';
import { setLanguage } from '../src/i18n';
import { buildReport } from '../src/ui/report';

beforeEach(() => {
  vi.stubGlobal('location', { pathname: '/c/abc123' });
  vi.stubGlobal('window', { innerWidth: 1280.6, innerHeight: 720 });
  vi.stubGlobal('document', { querySelector: () => null, documentElement: {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLanguage('en', { persist: false });
});

describe('buildReport', () => {
  it('a place from the HUD: the game only, the server resolves the node', () => {
    setLanguage('ru', { persist: false });
    const body = buildReport({ type: 'location', text: '  ', categories: ['floating'], where: { kind: 'current', gameId: 'g1' } });
    expect(body).toEqual({
      type: 'location',
      categories: ['floating'],
      game: { gameId: 'g1' },
      context: { lang: 'ru', path: '/c/abc123', viewport: { w: 1281, h: 720 }, appVersion: 'dev' },
    });
    expect(parseReport(body)).toMatchObject({ type: 'location', game: { gameId: 'g1' }, lang: 'ru', viewport: '1281x720' });
  });

  it('a round of a finished game', () => {
    const body = buildReport({ type: 'location', text: 'Under the bridge', categories: [], where: { kind: 'round', gameId: 'g1', round: 3 } });
    expect(body.game).toEqual({ gameId: 'g1', round: 3 });
    expect(body.categories).toBeUndefined();
    expect(parseReport(body).text).toBe('Under the bridge');
  });

  it('other types never carry a game or categories', () => {
    const body = buildReport({ type: 'translation', text: 'Typo', categories: ['visual'], where: { kind: 'current', gameId: 'g1' } });
    expect(body.game).toBeUndefined();
    expect(body.categories).toBeUndefined();
    expect(parseReport(body)).toMatchObject({ type: 'translation', text: 'Typo', game: null, categories: [] });
  });
});
