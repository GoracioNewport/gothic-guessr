import { describe, expect, it } from 'vitest';
import type { GameSettings } from '../src/contracts';
import {
  MAX_SEED,
  SETTINGS_PARAMS,
  applySettingsToParams,
  parseFlag,
  resolveSettings,
  settingsFromUrl,
  settingsToSearch,
} from '../src/game/state';

const ALL = ['khorinis', 'valley', 'jharkendar'];

describe('settingsFromUrl', () => {
  it('reads every parameter of SPEC 9.2', () => {
    expect(settingsFromUrl('?seed=42&mode=hardcore&worlds=khorinis,valley&nomove=1&nolook=1', ALL)).toEqual({
      seed: 42,
      mode: 'hardcore',
      worlds: ['khorinis', 'valley'],
      noMove: true,
      noLook: true,
    });
  });

  it('returns nulls for absent parameters and false for absent flags', () => {
    expect(settingsFromUrl('', ALL)).toEqual({ seed: null, mode: null, worlds: null, noMove: false, noLook: false });
    expect(settingsFromUrl('?seed=abc&mode=easy', ALL)).toEqual({ seed: null, mode: null, worlds: null, noMove: false, noLook: false });
    expect(settingsFromUrl(new URL('http://localhost:5173/?seed=7'), ALL).seed).toBe(7);
    expect(settingsFromUrl(new URLSearchParams({ nomove: '1' }), ALL).noMove).toBe(true);
  });

  it('nolook implies nomove; nomove alone leaves nolook off', () => {
    expect(settingsFromUrl('?nolook=1', ALL)).toMatchObject({ noMove: true, noLook: true });
    expect(settingsFromUrl('?nolook=1&nomove=0', ALL)).toMatchObject({ noMove: true, noLook: true });
    expect(settingsFromUrl('?nomove=1', ALL)).toMatchObject({ noMove: true, noLook: false });
    expect(settingsFromUrl('?nomove=0&nolook=0', ALL)).toMatchObject({ noMove: false, noLook: false });
  });

  it('parseFlag accepts 1/true/yes/on case-insensitively', () => {
    for (const v of ['1', 'true', 'TRUE', ' yes ', 'On']) expect(parseFlag(v), v).toBe(true);
    for (const v of [null, '', '0', 'false', 'no', 'off', '2', 'nolook']) expect(parseFlag(v), String(v)).toBe(false);
  });

  it('worlds: drops unknown slugs, deduplicates, orders like the index, empty → null (= all)', () => {
    expect(settingsFromUrl('?worlds=valley,khorinis', ALL).worlds).toEqual(['khorinis', 'valley']);
    expect(settingsFromUrl('?worlds=Valley,%20JHARKENDAR%20,valley', ALL).worlds).toEqual(['valley', 'jharkendar']);
    expect(settingsFromUrl('?worlds=irdorath,valley', ALL).worlds).toEqual(['valley']);
    expect(settingsFromUrl('?worlds=irdorath', ALL).worlds).toBeNull();
    expect(settingsFromUrl('?worlds=', ALL).worlds).toBeNull();
    expect(settingsFromUrl('?worlds=,,', ALL).worlds).toBeNull();
    // Without the available list nothing is dropped (the caller resolves later).
    expect(settingsFromUrl('?worlds=irdorath,valley').worlds).toEqual(['irdorath', 'valley']);
  });
});

describe('resolveSettings', () => {
  it('fills defaults: random seed, mixed, all worlds, toggles off', () => {
    const s = resolveSettings({}, ALL);
    expect(s.seed).toBeGreaterThanOrEqual(1);
    expect(s.seed).toBeLessThanOrEqual(MAX_SEED);
    expect(s).toMatchObject({ mode: 'mixed', worlds: ALL, noMove: false, noLook: false });
    expect(s.worlds).not.toBe(ALL); // a copy
    expect(resolveSettings({ seed: null, mode: null, worlds: null }, ALL)).toMatchObject({ mode: 'mixed', worlds: ALL });
  });

  it('keeps what is given, normalises worlds and the nolook → nomove rule', () => {
    expect(resolveSettings({ seed: 9, mode: 'classic', worlds: ['valley', 'nope', 'valley'], noLook: true }, ALL)).toEqual({
      seed: 9,
      mode: 'classic',
      worlds: ['valley'],
      noMove: true,
      noLook: true,
    });
    expect(resolveSettings({ seed: 9, worlds: ['nope'] }, ALL).worlds).toEqual(ALL);
    expect(resolveSettings({ seed: 2 ** 32 + 5 }, ALL).seed).toBe(5);
    expect(resolveSettings({ seed: 1, noMove: true }, ALL)).toMatchObject({ noMove: true, noLook: false });
  });

  it('follows the available list when some worlds failed to load', () => {
    expect(resolveSettings({ seed: 1 }, ['khorinis', 'jharkendar']).worlds).toEqual(['khorinis', 'jharkendar']);
    expect(resolveSettings({ seed: 1, worlds: ['valley', 'jharkendar'] }, ['khorinis', 'jharkendar']).worlds).toEqual(['jharkendar']);
    expect(() => resolveSettings({ seed: 1 }, [])).toThrow(/no worlds available/);
  });
});

describe('settingsToSearch', () => {
  const base: GameSettings = { seed: 123, mode: 'mixed', worlds: ['khorinis', 'valley'], noMove: false, noLook: false };

  it('writes the SPEC 9.2 query string', () => {
    expect(settingsToSearch(base)).toBe('?seed=123&mode=mixed&worlds=khorinis%2Cvalley');
    expect(settingsToSearch({ ...base, noMove: true })).toBe('?seed=123&mode=mixed&worlds=khorinis%2Cvalley&nomove=1');
    expect(settingsToSearch({ ...base, noMove: true, noLook: true })).toBe('?seed=123&mode=mixed&worlds=khorinis%2Cvalley&nomove=1&nolook=1');
    // noLook alone still writes nomove=1 (the invariant holds in the URL too).
    expect(settingsToSearch({ ...base, noLook: true })).toContain('nomove=1&nolook=1');
  });

  it('omits worlds when every available world is enabled', () => {
    expect(settingsToSearch({ ...base, worlds: ALL }, ALL)).toBe('?seed=123&mode=mixed');
    expect(settingsToSearch({ ...base, worlds: ['jharkendar', 'khorinis', 'valley'] }, ALL)).toBe('?seed=123&mode=mixed');
    expect(settingsToSearch({ ...base, worlds: ALL })).toBe('?seed=123&mode=mixed&worlds=khorinis%2Cvalley%2Cjharkendar');
    expect(settingsToSearch({ ...base, worlds: ['valley', 'khorinis'] }, ALL)).toBe('?seed=123&mode=mixed&worlds=khorinis%2Cvalley');
  });

  it('round-trips through settingsFromUrl + resolveSettings', () => {
    const cases: GameSettings[] = [
      base,
      { ...base, worlds: ALL },
      { seed: 0, mode: 'classic', worlds: ['jharkendar'], noMove: true, noLook: false },
      { seed: MAX_SEED, mode: 'hardcore', worlds: ['valley', 'jharkendar'], noMove: true, noLook: true },
    ];
    for (const s of cases) {
      for (const all of [ALL, undefined]) {
        const search = settingsToSearch(s, all);
        const back = resolveSettings(settingsFromUrl(search, ALL), ALL);
        expect(back, search).toEqual(s);
        // The full URL form works too.
        expect(resolveSettings(settingsFromUrl(`http://localhost:5173/${search}#frag`, ALL), ALL)).toEqual(s);
      }
    }
  });

  it('applySettingsToParams keeps foreign parameters and clears stale ones', () => {
    const params = new URLSearchParams('?debug=1&worlds=valley&nolook=1&nomove=1&seed=5');
    applySettingsToParams(params, { seed: 7, mode: 'classic', worlds: ALL, noMove: false, noLook: false }, ALL);
    expect(params.toString()).toBe('debug=1&seed=7&mode=classic');
    expect(SETTINGS_PARAMS).toEqual(['seed', 'mode', 'worlds', 'nomove', 'nolook']);
  });
});
