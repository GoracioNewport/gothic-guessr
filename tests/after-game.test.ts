/**
 * After a game: the summary's replay button per game kind, the nickname editor's helpers, and the daily countdown
 * row (fixed-width `HH:MM:SS`, the message split around its placeholder).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage, t } from '../src/i18n';
import { de } from '../src/i18n/de';
import { en } from '../src/i18n/en';
import { pl } from '../src/i18n/pl';
import { ru } from '../src/i18n/ru';
import { ApiRequestError } from '../src/net/api';
import { countdownText, splitAround } from '../src/pages/daily';
import { replayAction, replaySettings } from '../src/pages/summary';
import { nicknameErrorText, normaliseNickname } from '../src/ui/nickname';

afterEach(() => setLanguage('en', { persist: false }));

describe('summary replay button', () => {
  it('solo: Play again', () => {
    expect(replayAction('solo')).toBe('playAgain');
  });
  it('challenge: a new solo game, never "again" (one attempt per player)', () => {
    expect(replayAction('challenge')).toBe('newGame');
  });
  it('daily: none, only Main menu', () => {
    expect(replayAction('daily')).toBeNull();
  });
  it('replays with the same settings and a round count solo offers', () => {
    const base = { mode: 'classic' as const, worlds: ['khorinis'], noMove: true, noLook: false, timeLimit: 60 };
    expect(replaySettings({ ...base, rounds: 3 })).toEqual({ ...base, rounds: 3 });
    expect(replaySettings({ ...base, rounds: 10 })).toEqual({ ...base, rounds: 10 });
    expect(replaySettings({ ...base, rounds: 30 })).toEqual({ ...base, rounds: 5 });
  });
  it('room games end on the room page: none', () => {
    expect(replayAction('party')).toBeNull();
    expect(replayAction('duel')).toBeNull();
  });
});

describe('nickname editor helpers', () => {
  it('normalises like the server: trimmed, inner whitespace collapsed', () => {
    expect(normaliseNickname('  Lord   Hagen ')).toBe('Lord Hagen');
    expect(normaliseNickname('Xardas\t\tder\nDunkle')).toBe('Xardas der Dunkle');
    expect(normaliseNickname('Diego')).toBe('Diego');
  });
  it('localizes a refusal: the filter, the rules for a malformed name, anything else', () => {
    setLanguage('ru', { persist: false });
    expect(nicknameErrorText(new ApiRequestError('nickname_rejected', 422))).toBe(ru['error.nickname_rejected']);
    expect(nicknameErrorText(new ApiRequestError('bad_request', 400))).toBe(ru['menu.nicknameRules']);
    expect(nicknameErrorText(new ApiRequestError('rate_limited', 429))).toBe(ru['error.rate_limited']);
    expect(nicknameErrorText(new Error('boom'))).toBe(ru['error.unknown']);
  });
});

describe('daily countdown', () => {
  it('is always HH:MM:SS (eight characters all day)', () => {
    expect(countdownText(86_400_000)).toBe('24:00:00');
    expect(countdownText(18 * 3600_000 + 12 * 60_000 + 3_000)).toBe('18:12:03');
    expect(countdownText(9 * 3600_000 + 5_000)).toBe('09:00:05');
    expect(countdownText(59_000)).toBe('00:00:59');
    expect(countdownText(1)).toBe('00:00:01');
    expect(countdownText(0)).toBe('00:00:00');
    expect(countdownText(-5)).toBe('00:00:00');
  });

  it('splits a message around its placeholder, both parts trimmed', () => {
    expect(splitAround('Next challenge in \u0001', '\u0001')).toEqual(['Next challenge in', '']);
    expect(splitAround('\u0001 left', '\u0001')).toEqual(['', 'left']);
    expect(splitAround('no marker', '\u0001')).toEqual(['no marker', '']);
  });

  it('every language puts the time into its "next challenge" line exactly once', () => {
    for (const dict of [en, de, pl, ru]) {
      expect(dict['daily.nextIn'].split('{time}')).toHaveLength(2);
    }
    setLanguage('pl', { persist: false });
    const [before] = splitAround(t('daily.nextIn', { time: '\u0001' }), '\u0001');
    expect(before).toBe(pl['daily.nextIn'].replace('{time}', '').trim());
  });
});

describe('new i18n keys', () => {
  it('are translated in every language', () => {
    for (const dict of [de, pl, ru]) {
      for (const key of ['nick.change', 'summary.newGame', 'summary.newGameHint'] as const) {
        expect(dict[key]).toBeTruthy();
        expect(dict[key]).not.toBe(en[key]);
      }
    }
  });
});
