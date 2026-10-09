/**
 * Wordle-style share text of a daily result (SPEC §10.5). Pure. Contains no coordinates or place names.
 *
 * ```
 * Gothic II Guessr — Daily 2026-10-07
 * 18 450 / 25 000
 * 🟩🟩🟨🟥⬛
 * https://example.org/daily
 * ```
 */
import type { RoundResultView } from '../../shared/api';

/** Square for one round: 🟩 ≥ 4000, 🟨 ≥ 2000, 🟧 ≥ 500, 🟥 < 500, ⬛ wrong world / timeout / no guess. */
export function roundSquare(r: Pick<RoundResultView, 'score' | 'distanceM' | 'timedOut'>): string {
  if (r.timedOut || r.distanceM === null) return '⬛';
  if (r.score >= 4000) return '🟩';
  if (r.score >= 2000) return '🟨';
  if (r.score >= 500) return '🟧';
  return '🟥';
}

/** `18450` → `18 450` (plain space as thousands separator, locale-independent). */
export function groupThousands(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function dailyShareText(opts: {
  date: string;
  results: readonly Pick<RoundResultView, 'score' | 'distanceM' | 'timedOut'>[];
  maxTotal: number;
  origin: string;
}): string {
  const total = opts.results.reduce((s, r) => s + r.score, 0);
  return [
    `Gothic Guessr — Daily ${opts.date}`,
    `${groupThousands(total)} / ${groupThousands(opts.maxTotal)}`,
    opts.results.map(roundSquare).join(''),
    `${opts.origin.replace(/\/+$/, '')}/daily`,
  ].join('\n');
}
