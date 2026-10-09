import { describe, expect, it } from 'vitest';
import { normaliseRoomCode } from '../src/pages/menu';
import { defaultSoloSettings, sanitiseSoloSettings } from '../src/pages/setup';
import { applyToggleRules, resultKind } from '../src/ui/screens';

const ALL = ['khorinis', 'valley', 'jharkendar'];

describe('applyToggleRules (SPEC 9.2)', () => {
  it('enabling No look enables No move', () => {
    expect(applyToggleRules({ noMove: false, noLook: false }, { noLook: true })).toEqual({ noMove: true, noLook: true });
  });
  it('disabling No move disables No look', () => {
    expect(applyToggleRules({ noMove: true, noLook: true }, { noMove: false })).toEqual({ noMove: false, noLook: false });
  });
  it('No move alone leaves No look off; disabling No look keeps No move', () => {
    expect(applyToggleRules({ noMove: false, noLook: false }, { noMove: true })).toEqual({ noMove: true, noLook: false });
    expect(applyToggleRules({ noMove: true, noLook: true }, { noLook: false })).toEqual({ noMove: true, noLook: false });
  });
});

describe('solo setup settings (SPEC 10.1)', () => {
  it('defaults to every world, Mixed, movement on, no time limit, 5 rounds', () => {
    expect(defaultSoloSettings(ALL)).toEqual({ mode: 'mixed', worlds: ALL, noMove: false, noLook: false, timeLimit: 0, rounds: 5 });
  });
  it('keeps a valid stored choice, in worlds.json order', () => {
    const s = sanitiseSoloSettings({ mode: 'hardcore', worlds: ['jharkendar', 'khorinis'], noMove: true, noLook: false, timeLimit: 120 }, ALL);
    expect(s).toEqual({ mode: 'hardcore', worlds: ['khorinis', 'jharkendar'], noMove: true, noLook: false, timeLimit: 120, rounds: 5 });
  });
  it('drops unknown worlds and invalid values, No look implies No move', () => {
    const s = sanitiseSoloSettings({ mode: 'easy', worlds: ['atlantis'], noLook: true, timeLimit: 45, rounds: 7 }, ALL);
    expect(s).toEqual({ mode: 'mixed', worlds: ALL, noMove: true, noLook: true, timeLimit: 0, rounds: 5 });
  });
  it('keeps a stored round count of 3, 5 or 10', () => {
    for (const rounds of [3, 5, 10]) expect(sanitiseSoloSettings({ mode: 'mixed', worlds: ALL, rounds }, ALL).rounds).toBe(rounds);
    expect(sanitiseSoloSettings({ mode: 'mixed', worlds: ALL, rounds: '10' }, ALL).rounds).toBe(5);
  });
  it('falls back to the defaults for garbage', () => {
    expect(sanitiseSoloSettings(null, ALL)).toEqual(defaultSoloSettings(ALL));
    expect(sanitiseSoloSettings('x', ['valley'])).toEqual(defaultSoloSettings(['valley']));
  });
});

describe('resultKind', () => {
  const answer = { world: 'khorinis', x: 0, z: 0 };
  it('distance for a same-world guess', () => {
    expect(resultKind({ guess: { world: 'khorinis', x: 1, z: 1 }, answer, distanceM: 0.1, timedOut: false })).toBe('distance');
  });
  it('wrong world when the worlds differ', () => {
    expect(resultKind({ guess: { world: 'valley', x: 1, z: 1 }, answer, distanceM: null, timedOut: false })).toBe('wrongWorld');
  });
  it('timeout and no guess', () => {
    expect(resultKind({ guess: null, answer, distanceM: null, timedOut: true })).toBe('timedOut');
    expect(resultKind({ guess: null, answer, distanceM: null, timedOut: false })).toBe('noGuess');
  });
});

describe('normaliseRoomCode', () => {
  it('upper-cases and strips separators', () => {
    expect(normaliseRoomCode(' abc-de ')).toBe('ABCDE');
  });
  it('rejects too short or too long codes', () => {
    expect(normaliseRoomCode('ab')).toBeNull();
    expect(normaliseRoomCode('ABCD')).toBeNull();
    expect(normaliseRoomCode('ABCDEF')).toBeNull();
    expect(normaliseRoomCode('ABCDEFGHIJ')).toBeNull();
  });
  it("accepts exactly the server's format: 5 letters without I and O, no digits", () => {
    expect(normaliseRoomCode('qwhtr')).toBe('QWHTR');
    expect(normaliseRoomCode('ABCDI')).toBeNull();
    expect(normaliseRoomCode('ABCDO')).toBeNull();
    expect(normaliseRoomCode('ABC12')).toBeNull();
    expect(normaliseRoomCode('AB CD!')).toBeNull();
  });
});
