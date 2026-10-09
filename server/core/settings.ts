/**
 * Game settings rules (SPEC §10.1, §10.5): validation of {@link PublicSettings} sent by clients, round counts per kind,
 * the daily defaults, and UTC date helpers. Pure.
 */
import { ROUND_COUNTS, TIME_LIMITS } from '../../shared/api';
import type { ChallengeKind, GameMode, PublicSettings } from '../../shared/api';
import { ApiFailure } from './errors';

export const MODES: readonly GameMode[] = ['classic', 'mixed', 'hardcore'];

/** Rounds of a daily game, and the default of a solo game or a party. */
export const SOLO_ROUNDS = 5;
/** Allowed party round counts. */
export const PARTY_ROUNDS: readonly number[] = ROUND_COUNTS;
/** Allowed solo (quick play) round counts; a challenge inherits the count of the solo game it was created by. */
export const SOLO_ROUND_CHOICES: readonly number[] = ROUND_COUNTS;
/** Duel round cap (SPEC §10.1): after round 30 the higher HP wins. */
export const DUEL_MAX_ROUNDS = 30;
/** Duel hard cap per round, seconds (applies when the base limit is off). */
export const DUEL_HARD_CAP_S = 300;

/** Grace after a deadline during which a guess still counts (SPEC §10.4). */
export const DEADLINE_GRACE_MS = 2_000;

/** Daily defaults (SPEC §10.1): all worlds, Mixed, movement on, 2 min per round, 5 rounds. */
export function defaultDailySettings(allWorlds: readonly string[]): PublicSettings {
  return { mode: 'mixed', worlds: [...allWorlds], noMove: false, noLook: false, timeLimit: 120, rounds: SOLO_ROUNDS };
}

/**
 * Validate settings from a client and normalise them: worlds deduplicated, unknown slugs rejected, ordered like
 * `allWorlds` (worlds.json order); `noLook` forces `noMove`; `timeLimit` one of {@link TIME_LIMITS}; `rounds` by
 * `kind` (solo and party: 3|5|10 with default 5, daily: always 5, duel: 30). Throws `bad_request`.
 */
export function parseSettings(raw: unknown, allWorlds: readonly string[], kind: ChallengeKind = 'solo'): PublicSettings {
  const bad = (msg: string): never => {
    throw new ApiFailure('bad_request', `settings: ${msg}`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('not an object');
  const s = raw as Record<string, unknown>;
  const mode = s.mode;
  if (typeof mode !== 'string' || !MODES.includes(mode as GameMode)) bad('mode');
  if (!Array.isArray(s.worlds) || s.worlds.length === 0) return bad('worlds');
  const wanted = new Set<string>();
  for (const w of s.worlds) {
    if (typeof w !== 'string' || !allWorlds.includes(w)) bad(`unknown world ${String(w)}`);
    wanted.add(w as string);
  }
  const worlds = allWorlds.filter((w) => wanted.has(w));
  const noLook = s.noLook === true;
  const noMove = noLook || s.noMove === true;
  if (s.noLook !== undefined && typeof s.noLook !== 'boolean') bad('noLook');
  if (s.noMove !== undefined && typeof s.noMove !== 'boolean') bad('noMove');
  const timeLimit = s.timeLimit ?? 0;
  if (typeof timeLimit !== 'number' || !TIME_LIMITS.includes(timeLimit)) bad('timeLimit');
  let rounds: number;
  if (kind === 'party' || kind === 'solo') {
    rounds = s.rounds === undefined ? SOLO_ROUNDS : (s.rounds as number);
    if (!(kind === 'party' ? PARTY_ROUNDS : SOLO_ROUND_CHOICES).includes(rounds)) bad('rounds');
  } else if (kind === 'duel') {
    rounds = DUEL_MAX_ROUNDS;
  } else {
    rounds = SOLO_ROUNDS;
  }
  return { mode: mode as GameMode, worlds, noMove, noLook, timeLimit: timeLimit as number, rounds };
}

/** Settings stored earlier (DB JSON): reduce worlds to the loaded ones, keep the rest. Null when no world is left. */
export function settingsForLoadedWorlds(settings: PublicSettings, allWorlds: readonly string[]): PublicSettings | null {
  const worlds = allWorlds.filter((w) => settings.worlds.includes(w));
  return worlds.length === 0 ? null : { ...settings, worlds };
}

/** `YYYY-MM-DD` of an epoch-ms instant, UTC. */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** True for a real calendar date in `YYYY-MM-DD` form. */
export function isIsoDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

/** Challenge code of a day's daily: `daily-2026-10-07`. */
export function dailyCode(date: string): string {
  return `daily-${date}`;
}
