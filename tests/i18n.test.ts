import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiErrorCode } from '../shared/api';
import {
  DICTIONARIES,
  LANGS,
  LANG_STORAGE_KEY,
  detectLanguage,
  errorMessage,
  formatDistance,
  formatNumber,
  formatTimeLimit,
  getLanguage,
  interpolate,
  languageFromList,
  onLanguageChange,
  pluralCategory,
  readStoredLanguage,
  setLanguage,
  t,
  tp,
  translate,
  worldDescription,
  worldName,
} from '../src/i18n';
import type { Lang, MessageKey, PluralForms } from '../src/i18n';

const keysOf = (lang: Lang): string[] => Object.keys(DICTIONARIES[lang]).sort();

/** Placeholders of an entry; for plurals the union over every form. */
function placeholders(entry: string | PluralForms): string[] {
  const texts = typeof entry === 'string' ? [entry] : Object.values(entry).filter((v): v is string => typeof v === 'string');
  const names = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(/\{(\w+)\}/g)) names.add(m[1]!);
  return [...names].sort();
}

afterEach(() => {
  setLanguage('en', { persist: false });
  vi.unstubAllGlobals();
});

describe('dictionaries', () => {
  const enKeys = keysOf('en');

  it('every language has exactly the English key set', () => {
    for (const lang of LANGS) expect(keysOf(lang), lang).toEqual(enKeys);
  });

  it('every key has the same placeholders in every language', () => {
    for (const key of enKeys as MessageKey[]) {
      const expected = placeholders(DICTIONARIES.en[key]);
      for (const lang of LANGS) {
        expect(placeholders(DICTIONARIES[lang][key]), `${lang} ${key}`).toEqual(expected);
      }
    }
  });

  it('plural keys stay plural and string keys stay strings in every language', () => {
    for (const key of enKeys as MessageKey[]) {
      const kind = typeof DICTIONARIES.en[key];
      for (const lang of LANGS) expect(typeof DICTIONARIES[lang][key], `${lang} ${key}`).toBe(kind);
    }
  });

  it('every plural entry covers the integer categories of its language', () => {
    for (const lang of LANGS) {
      const categories = new Set([0, 1, 2, 3, 5, 11, 21, 22, 25, 100, 101, 102, 1000].map((n) => pluralCategory(n, lang)));
      for (const [key, entry] of Object.entries(DICTIONARIES[lang])) {
        if (typeof entry === 'string') continue;
        for (const c of categories) expect(entry[c], `${lang} ${key} ${c}`).toBeTruthy();
        expect(entry.other, `${lang} ${key} other`).toBeTruthy();
      }
    }
  });

  it('has no empty or blank strings and no stray whitespace', () => {
    for (const lang of LANGS) {
      for (const [key, entry] of Object.entries(DICTIONARIES[lang])) {
        const texts = typeof entry === 'string' ? [entry] : Object.values(entry);
        for (const text of texts) {
          expect(typeof text === 'string' && text.trim().length > 0, `${lang} ${key}`).toBe(true);
          expect(text, `${lang} ${key}`).toBe((text as string).trim());
        }
      }
    }
  });

  it('localizes every server error code', () => {
    const codes: ApiErrorCode[] = [
      'auth', 'not_found', 'forbidden', 'banned', 'rate_limited', 'nickname_rejected', 'already_played',
      'room_full', 'room_started', 'room_closed', 'not_host', 'bad_request', 'round_over', 'conflict', 'internal',
    ];
    for (const lang of LANGS) {
      setLanguage(lang, { persist: false });
      for (const code of codes) {
        expect(errorMessage(code), `${lang} ${code}`).not.toBe(t('error.unknown'));
      }
    }
    expect(errorMessage('something_new')).toBe(t('error.unknown'));
  });

  it('uses the official world names', () => {
    const names = (lang: Lang): string[] =>
      ['khorinis', 'valley', 'jharkendar'].map((slug) => translate(lang, `world.${slug}` as MessageKey));
    expect(names('en')).toEqual(['Khorinis', 'Valley of Mines', 'Jharkendar']);
    expect(names('de')).toEqual(['Khorinis', 'Minental', 'Jharkendar']);
    expect(names('pl')).toEqual(['Khorinis', 'Górnicza Dolina', 'Jarkendar']);
    expect(names('ru')).toEqual(['Хоринис', 'Долина Рудников', 'Яркендар']);
  });
});

describe('detectLanguage', () => {
  it('uses the first supported primary subtag of navigator.languages', () => {
    expect(detectLanguage({ stored: null, languages: ['ru-RU', 'en-US'] })).toBe('ru');
    expect(detectLanguage({ stored: null, languages: ['fr-FR', 'de-AT', 'en'] })).toBe('de');
    expect(detectLanguage({ stored: null, languages: ['PL'] })).toBe('pl');
    expect(detectLanguage({ stored: null, languages: ['en-GB'] })).toBe('en');
    expect(detectLanguage({ stored: null, languages: ['de_CH'] })).toBe('de');
  });

  it('falls back to English when nothing is supported', () => {
    expect(detectLanguage({ stored: null, languages: ['fr-FR', 'uk-UA'] })).toBe('en');
    expect(detectLanguage({ stored: null, languages: [] })).toBe('en');
  });

  it('prefers the stored choice over the browser, ignoring invalid stored values', () => {
    expect(detectLanguage({ stored: 'pl', languages: ['ru-RU'] })).toBe('pl');
    expect(detectLanguage({ stored: 'xx', languages: ['ru-RU'] })).toBe('ru');
    expect(languageFromList(['pt-BR', 'ru'])).toBe('ru');
  });

  it('reads localStorage and navigator, surviving a throwing storage', () => {
    const store = new Map<string, string>([[LANG_STORAGE_KEY, 'de']]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    vi.stubGlobal('navigator', { languages: ['ru-RU'], language: 'ru-RU' });
    expect(detectLanguage()).toBe('de');
    store.clear();
    expect(detectLanguage()).toBe('ru');
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(readStoredLanguage()).toBeNull();
    expect(detectLanguage()).toBe('ru');
    expect(() => setLanguage('pl')).not.toThrow();
    expect(getLanguage()).toBe('pl');
  });
});

describe('setLanguage', () => {
  it('persists the choice and notifies subscribers once per change', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    const seen: Lang[] = [];
    const off = onLanguageChange((lang) => seen.push(lang));
    setLanguage('ru');
    setLanguage('ru');
    setLanguage('de');
    off();
    setLanguage('pl');
    expect(seen).toEqual(['ru', 'de']);
    expect(store.get(LANG_STORAGE_KEY)).toBe('pl');
    expect(t('round.guess')).toBe('Zgadnij');
  });
});

describe('plurals', () => {
  it('Russian: 1 one, 2 few, 5 many, 21 one', () => {
    expect([1, 2, 5, 21].map((n) => pluralCategory(n, 'ru'))).toEqual(['one', 'few', 'many', 'one']);
    setLanguage('ru', { persist: false });
    expect([1, 2, 5, 21].map((n) => tp('room.playerCount', n))).toEqual(['1 игрок', '2 игрока', '5 игроков', '21 игрок']);
    expect(tp('time.seconds', 22)).toBe('22 секунды');
  });

  it('Polish: 1 one, 2 few, 5 many, 21 many', () => {
    expect([1, 2, 5, 21].map((n) => pluralCategory(n, 'pl'))).toEqual(['one', 'few', 'many', 'many']);
    setLanguage('pl', { persist: false });
    expect([1, 2, 5, 21].map((n) => tp('settings.roundsCount', n))).toEqual(['1 runda', '2 rundy', '5 rund', '21 rund']);
    expect(tp('time.minutes', 22)).toBe('22 minuty');
  });

  it('English and German: one / other, count formatted with the locale', () => {
    expect(tp('settings.roundsCount', 1)).toBe('1 round');
    expect(tp('settings.roundsCount', 10)).toBe('10 rounds');
    expect(tp('room.playerCount', 1000)).toBe('1,000 players');
    setLanguage('de', { persist: false });
    expect(tp('time.minutes', 1)).toBe('1 Minute');
    expect(tp('time.minutes', 5)).toBe('5 Minuten');
    expect(t('settings.roundsCount', { count: 3 })).toBe('3 Runden');
  });
});

describe('messages and formatting', () => {
  it('fills placeholders and keeps unknown ones visible', () => {
    expect(t('round.counter', { round: 2, total: 5 })).toBe('Round 2/5');
    expect(interpolate('{a} and {b}', { a: 'x' })).toBe('x and {b}');
  });

  it('formats numbers and distances with the active locale', () => {
    expect(formatNumber(18450)).toBe('18,450');
    expect(formatDistance(12.34)).toBe('12.3 m');
    setLanguage('de', { persist: false });
    expect(formatNumber(18450)).toBe('18.450');
    expect(formatDistance(12.34)).toBe('12,3 m');
    setLanguage('ru', { persist: false });
    expect(formatNumber(18450).replace(/\s/g, ' ')).toBe('18 450');
    expect(formatDistance(12.34).replace(/\s/g, ' ')).toBe('12,3 м');
  });

  it('formats time limits', () => {
    expect([0, 30, 60, 120, 300].map(formatTimeLimit)).toEqual(['No limit', '30 s', '1 min', '2 min', '5 min']);
    setLanguage('ru', { persist: false });
    expect(formatTimeLimit(120)).toBe('2 мин');
  });

  it('localizes world names with a fallback for unknown slugs', () => {
    setLanguage('ru', { persist: false });
    expect(worldName('valley', 'Valley of Mines')).toBe('Долина Рудников');
    expect(worldName('newworld', 'New World')).toBe('New World');
    expect(worldName('newworld')).toBe('newworld');
    expect(worldDescription('khorinis')).toBe('Остров: город, фермы, леса, монастырь.');
    expect(worldDescription('newworld', 'desc')).toBe('desc');
  });

  it('starts in English', () => {
    expect(getLanguage()).toBe('en');
    expect(t('start.startGame')).toBe('Start game');
  });
});
