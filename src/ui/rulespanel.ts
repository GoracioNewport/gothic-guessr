/**
 * Rules panel: the "Rules" block shown to the right of the main window (stacked below it on narrow screens) on the
 * quick play setup and the daily page, and meant for the room lobby too. It lists the rules of a game as short lines
 * built from its current settings ("3 rounds will be played", "Each round lasts 1 minute", "The camera is frozen", …),
 * so it changes as the player changes the settings.
 *
 * API (pure part, unit-tested in tests/rulespanel.test.ts):
 *
 *   ruleLines(settings, { kind, maxScore?, perfectRadiusM?, duelHp?, duelCountdownS?, duelHardCapS?,
 *                         duelMaxRounds?, endRoundGraceS? }) → RuleLine[]
 *     `kind` is what is being played: 'solo' (quick play), 'daily', 'challenge', 'party' (room) or 'duel' (room).
 *     Each line is `{ id, text }`; `text` is already translated into the active language, `id` names the rule so a
 *     caller can drop or reorder lines (e.g. `lines.filter((l) => l.id !== 'score')`). Ids:
 *       kind lines first   daily.once, daily.same, daily.next | challenge.once, challenge.same |
 *                          party.together, party.roundEnd, party.endEarly |
 *                          duel.hp, duel.damage, duel.multiplier, duel.countdown, duel.forfeit
 *       then               rounds, time, timeout (timed rounds and duels), movement, worlds, mode, score,
 *                          wrongWorld (more than one world), tiebreak (solo/daily/challenge), solo.challenge (solo)
 *     The numbers default to the game's constants (5000 points, 15 m, 6000 HP, 15 s, 5 min, round 30, 5 s).
 *
 * DOM part:
 *
 *   rulesPanel(settings, opts) → { root, update(settings) }
 *     `root` is an <aside class="g2-panel g2-rules"> with a heading and the list; `update` re-renders the list for new
 *     settings (call it from a settings `change` handler). Optional `opts.heading` replaces the "Rules" title,
 *     `opts.filter` drops lines.
 *
 *   withRules(main, rules) → HTMLElement
 *     The layout wrapper: `main` (the page's card) with the rules panel to its right; below it when the window is
 *     narrow (style.css `.g2-with-rules`). Append the wrapper to the screen instead of the card.
 */
import type { PublicSettings } from '../../shared/api';
import { formatNumber, t, tp, worldName } from '../i18n';
import { el, formatScore, ROUND_MAX_SCORE } from './dom';

/** What is being played. */
export type RulesKind = 'solo' | 'daily' | 'challenge' | 'party' | 'duel';

export interface RuleLine {
  /** Stable name of the rule (see the file header). */
  id: string;
  /** The line in the active language. */
  text: string;
}

export interface RuleOptions {
  kind: RulesKind;
  /** Points for a perfect round (default 5000). */
  maxScore?: number;
  /** Full points within this many metres (default 15, every world's `scoring.perfectRadiusM`). */
  perfectRadiusM?: number;
  /** Duel starting health (server/core/duel.ts DUEL_START_HP). */
  duelHp?: number;
  /** Seconds the other duellist has after the first guess (DUEL_COUNTDOWN_MS / 1000). */
  duelCountdownS?: number;
  /** Duel round cap when the base limit is off, seconds (server/core/settings.ts DUEL_HARD_CAP_S). */
  duelHardCapS?: number;
  /** After this round the higher health wins (DUEL_MAX_ROUNDS). */
  duelMaxRounds?: number;
  /** Seconds the players still guessing get when the host ends a party round (END_ROUND_COUNTDOWN_MS / 1000). */
  endRoundGraceS?: number;
  /** A disconnected duellist forfeits after this many seconds. */
  duelForfeitS?: number;
}

export const RULE_DEFAULTS = {
  maxScore: ROUND_MAX_SCORE,
  perfectRadiusM: 15,
  duelHp: 6000,
  duelCountdownS: 15,
  duelHardCapS: 300,
  duelMaxRounds: 30,
  endRoundGraceS: 5,
  duelForfeitS: 60,
} as const;

/** "Each round lasts 1 minute" / "… 30 seconds" (whole minutes when possible). */
function timeLine(seconds: number): string {
  return seconds % 60 === 0 ? tp('rules.time.minutes', seconds / 60) : tp('rules.time.seconds', seconds);
}

/** The rules of a game with `settings`, as translated lines (see the file header for ids and order). */
export function ruleLines(settings: PublicSettings, opts: RuleOptions): RuleLine[] {
  const o = { ...RULE_DEFAULTS, ...stripUndefined(opts) };
  const lines: RuleLine[] = [];
  const add = (id: string, text: string): void => {
    lines.push({ id, text });
  };

  switch (opts.kind) {
    case 'daily':
      add('daily.once', t('rules.daily.once'));
      add('daily.same', t('rules.daily.same'));
      add('daily.next', t('rules.daily.next'));
      break;
    case 'challenge':
      add('challenge.once', t('rules.challenge.once'));
      add('challenge.same', t('rules.challenge.same'));
      break;
    case 'party':
      add('party.together', t('rules.party.together'));
      add('party.roundEnd', t('rules.party.roundEnd'));
      add('party.endEarly', tp('rules.party.endEarly', o.endRoundGraceS));
      break;
    case 'duel':
      add('duel.hp', t('rules.duel.hp', { hp: formatNumber(o.duelHp) }));
      add('duel.damage', t('rules.duel.damage'));
      add('duel.multiplier', t('rules.duel.multiplier'));
      add('duel.countdown', tp('rules.duel.countdown', o.duelCountdownS));
      add('duel.forfeit', tp('rules.duel.forfeit', o.duelForfeitS));
      break;
    case 'solo':
      break;
  }

  if (opts.kind === 'duel') add('rounds', t('rules.duel.rounds', { count: formatNumber(o.duelMaxRounds) }));
  else add('rounds', tp('rules.rounds', settings.rounds));

  if (settings.timeLimit > 0) add('time', timeLine(settings.timeLimit));
  else if (opts.kind === 'duel') add('time', tp('rules.duel.timeCap', Math.round(o.duelHardCapS / 60)));
  else add('time', t('rules.time.off'));
  if (settings.timeLimit > 0 || opts.kind === 'duel') add('timeout', t('rules.timeout'));

  if (settings.noLook) add('movement', t('rules.noLook'));
  else if (settings.noMove) add('movement', t('rules.noMove'));
  else add('movement', t('rules.move'));

  const names = settings.worlds.map((slug) => worldName(slug)).join(', ');
  add('worlds', tp('rules.worlds', settings.worlds.length, { names }));
  add('mode', t(`rules.mode.${settings.mode}`));
  // "15 m" never splits across lines.
  const radius = formatNumber(o.perfectRadiusM, { style: 'unit', unit: 'meter', unitDisplay: 'short', maximumFractionDigits: 0 }).replace(/\s/g, '\u00a0');
  add('score', t('rules.score', { max: formatScore(o.maxScore), radius }));
  if (settings.worlds.length > 1) add('wrongWorld', t('rules.wrongWorld'));
  if (opts.kind === 'solo' || opts.kind === 'daily' || opts.kind === 'challenge') add('tiebreak', t('rules.tiebreak'));
  if (opts.kind === 'solo') add('solo.challenge', t('rules.solo.challenge'));
  return lines;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export interface RulesPanelOptions extends RuleOptions {
  /** Title of the panel (default "Rules"). */
  heading?: string;
  /** Keep only the lines this returns true for. */
  filter?: (line: RuleLine) => boolean;
}

export interface RulesPanel {
  root: HTMLElement;
  /** Re-render the lines for new settings. */
  update(settings: PublicSettings): void;
}

/** The rules block (see the file header). */
export function rulesPanel(settings: PublicSettings, opts: RulesPanelOptions): RulesPanel {
  const root = el('aside', 'g2-panel g2-rules');
  const heading = el('h2', 'g2-legend g2-rules-heading', opts.heading ?? t('rules.heading'));
  heading.id = `g2-rules-${opts.kind}`;
  root.setAttribute('aria-labelledby', heading.id);
  const list = el('ul', 'g2-rules-list');
  root.append(heading, list);
  const update = (next: PublicSettings): void => {
    const lines = ruleLines(next, opts).filter((l) => opts.filter?.(l) ?? true);
    list.replaceChildren(
      ...lines.map((line) => {
        const li = el('li', 'g2-rules-line', line.text);
        li.dataset.rule = line.id;
        return li;
      }),
    );
  };
  update(settings);
  return { root, update };
}

/** `main` with the rules panel beside it (below it on narrow screens). */
export function withRules(main: HTMLElement, rules: HTMLElement): HTMLElement {
  const wrap = el('div', 'g2-with-rules');
  wrap.append(main, rules);
  return wrap;
}
