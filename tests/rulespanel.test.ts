/**
 * Rules panel lines (src/ui/rulespanel.ts): built from the settings, translated, in a fixed order with stable ids.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { PublicSettings } from '../shared/api';
import { LANGS, setLanguage } from '../src/i18n';
import { ruleLines } from '../src/ui/rulespanel';
import type { RulesKind } from '../src/ui/rulespanel';

const ALL = ['khorinis', 'valley', 'jharkendar'];
const base: PublicSettings = { mode: 'mixed', worlds: ALL, noMove: false, noLook: false, timeLimit: 0, rounds: 5 };

const ids = (settings: PublicSettings, kind: RulesKind): string[] => ruleLines(settings, { kind }).map((l) => l.id);
const text = (settings: PublicSettings, kind: RulesKind, id: string): string | undefined =>
  ruleLines(settings, { kind }).find((l) => l.id === id)?.text;

afterEach(() => setLanguage('en', { persist: false }));

describe('ruleLines (en)', () => {
  it('quick play: rounds, time, movement, worlds, mode, score, wrong world, tie-break, challenge link', () => {
    expect(ids(base, 'solo')).toEqual(['rounds', 'time', 'movement', 'worlds', 'mode', 'score', 'wrongWorld', 'tiebreak', 'solo.challenge']);
    expect(text(base, 'solo', 'rounds')).toBe('5 rounds will be played');
    expect(text({ ...base, rounds: 3 }, 'solo', 'rounds')).toBe('3 rounds will be played');
    expect(text(base, 'solo', 'time')).toBe('No time limit');
    expect(text(base, 'solo', 'movement')).toBe('You can walk along the paths and look around');
    expect(text(base, 'solo', 'worlds')).toBe('Worlds: Khorinis, Valley of Mines, Jharkendar');
    expect(text(base, 'solo', 'score')).toBe('Up to 5,000 points per round, full points within 15\u00a0m');
  });

  it('follows the time limit, in whole minutes when possible, and adds the time-out rule', () => {
    expect(text({ ...base, timeLimit: 60 }, 'solo', 'time')).toBe('Each round lasts 1 minute');
    expect(text({ ...base, timeLimit: 120 }, 'solo', 'time')).toBe('Each round lasts 2 minutes');
    expect(text({ ...base, timeLimit: 30 }, 'solo', 'time')).toBe('Each round lasts 30 seconds');
    expect(ids({ ...base, timeLimit: 30 }, 'solo')).toContain('timeout');
    expect(ids(base, 'solo')).not.toContain('timeout');
  });

  it('movement: No move, then No look wins', () => {
    expect(text({ ...base, noMove: true }, 'solo', 'movement')).toBe('Movement is off: you can only look around');
    expect(text({ ...base, noMove: true, noLook: true }, 'solo', 'movement')).toBe('The camera is frozen: no walking, turning or zooming');
  });

  it('one world: singular label and no wrong-world rule', () => {
    const one = { ...base, worlds: ['valley'] };
    expect(text(one, 'solo', 'worlds')).toBe('World: Valley of Mines');
    expect(ids(one, 'solo')).not.toContain('wrongWorld');
  });

  it('mode lines', () => {
    expect(text({ ...base, mode: 'classic' }, 'solo', 'mode')).toMatch(/^Mode: Classic/);
    expect(text(base, 'solo', 'mode')).toMatch(/^Mode: Mixed/);
    expect(text({ ...base, mode: 'hardcore' }, 'solo', 'mode')).toMatch(/^Mode: Hardcore/);
  });

  it('daily and challenge lines come first, no challenge-link line', () => {
    const daily = ids({ ...base, timeLimit: 120 }, 'daily');
    expect(daily.slice(0, 3)).toEqual(['daily.once', 'daily.same', 'daily.next']);
    expect(daily).not.toContain('solo.challenge');
    expect(text(base, 'daily', 'daily.once')).toBe('One attempt per day');
    expect(text(base, 'daily', 'daily.same')).toBe('The same rounds for everyone');
    expect(ids(base, 'challenge').slice(0, 2)).toEqual(['challenge.once', 'challenge.same']);
  });

  it('party room lines', () => {
    const lines = ids({ ...base, rounds: 10, timeLimit: 120 }, 'party');
    expect(lines.slice(0, 3)).toEqual(['party.together', 'party.roundEnd', 'party.endEarly']);
    expect(lines).not.toContain('tiebreak');
    expect(text({ ...base, rounds: 10 }, 'party', 'rounds')).toBe('10 rounds will be played');
    expect(text(base, 'party', 'party.endEarly')).toMatch(/5 seconds$/);
  });

  it('duel lines: HP, multiplier, 15 s, 5-minute cap without a limit, round 30', () => {
    const duel = { ...base, rounds: 30 };
    expect(ids(duel, 'duel').slice(0, 5)).toEqual(['duel.hp', 'duel.damage', 'duel.multiplier', 'duel.countdown', 'duel.forfeit']);
    expect(text(duel, 'duel', 'duel.hp')).toBe('Both players start with 6,000 HP');
    expect(text(duel, 'duel', 'duel.countdown')).toBe('Once one player has guessed, the other has 15 seconds left');
    expect(text(duel, 'duel', 'time')).toBe('No time limit, but a round ends after 5 minutes at the latest');
    expect(text({ ...duel, timeLimit: 60 }, 'duel', 'time')).toBe('Each round lasts 1 minute');
    expect(text(duel, 'duel', 'rounds')).toMatch(/after round 30 the higher health wins$/);
    expect(ids(duel, 'duel')).toContain('timeout');
  });

  it('numbers can be overridden', () => {
    const lines = ruleLines(base, { kind: 'duel', duelHp: 3000, duelCountdownS: 10, perfectRadiusM: 20, maxScore: 1000 });
    expect(lines.find((l) => l.id === 'duel.hp')?.text).toBe('Both players start with 3,000 HP');
    expect(lines.find((l) => l.id === 'duel.countdown')?.text).toMatch(/10 seconds left$/);
    expect(lines.find((l) => l.id === 'score')?.text).toBe('Up to 1,000 points per round, full points within 20\u00a0m');
  });
});

describe('ruleLines in every language', () => {
  it('produces non-empty lines without unfilled placeholders for every kind', () => {
    const kinds: RulesKind[] = ['solo', 'daily', 'challenge', 'party', 'duel'];
    for (const lang of LANGS) {
      setLanguage(lang, { persist: false });
      for (const kind of kinds) {
        for (const settings of [base, { ...base, worlds: ['khorinis'], noLook: true, noMove: true, timeLimit: 30, rounds: 3 }]) {
          for (const line of ruleLines(settings, { kind })) {
            expect(line.text.length, `${lang} ${kind} ${line.id}`).toBeGreaterThan(0);
            expect(line.text, `${lang} ${kind} ${line.id}`).not.toMatch(/[{}]/);
          }
        }
      }
    }
  });

  it('Russian uses the owner\'s wording with correct plural cases', () => {
    setLanguage('ru', { persist: false });
    expect(text({ ...base, rounds: 3 }, 'solo', 'rounds')).toBe('Будет сыграно 3 раунда');
    expect(text(base, 'solo', 'rounds')).toBe('Будет сыграно 5 раундов');
    expect(text({ ...base, timeLimit: 60 }, 'solo', 'time')).toBe('Каждый раунд длится 1 минуту');
    expect(text({ ...base, timeLimit: 120 }, 'solo', 'time')).toBe('Каждый раунд длится 2 минуты');
    expect(text({ ...base, timeLimit: 300 }, 'solo', 'time')).toBe('Каждый раунд длится 5 минут');
    expect(text({ ...base, timeLimit: 30 }, 'solo', 'time')).toBe('Каждый раунд длится 30 секунд');
    expect(text(base, 'daily', 'daily.once')).toBe('Одна попытка в день');
  });

  it('Polish and German plural forms', () => {
    setLanguage('pl', { persist: false });
    expect(text({ ...base, rounds: 3 }, 'solo', 'rounds')).toBe('Zostaną rozegrane 3 rundy');
    expect(text({ ...base, rounds: 10 }, 'solo', 'rounds')).toBe('Zostanie rozegranych 10 rund');
    expect(text({ ...base, timeLimit: 60 }, 'solo', 'time')).toBe('Każda runda trwa 1 minutę');
    setLanguage('de', { persist: false });
    expect(text({ ...base, rounds: 3 }, 'solo', 'rounds')).toBe('Es werden 3 Runden gespielt');
    expect(text({ ...base, timeLimit: 60 }, 'solo', 'time')).toBe('Jede Runde dauert 1 Minute');
  });
});
