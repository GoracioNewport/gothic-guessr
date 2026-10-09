/**
 * Result squares in the Wordle style of the daily share text (SPEC §10.5), for display on the client. The share
 * text itself comes ready from the server (`GameSummaryView.shareText`); this module renders the same per-round
 * squares on the summary and splits a share text for display.
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

/** All squares of a game, in round order. */
export function squares(results: readonly Pick<RoundResultView, 'score' | 'distanceM' | 'timedOut'>[]): string {
  return results.map(roundSquare).join('');
}

/** The lines of a share text, trimmed, without empty ones (for a preview block). */
export function shareLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/** Absolute challenge link (`<origin>/c/<code>`). */
export function challengeLink(code: string, origin = location.origin): string {
  return `${origin.replace(/\/+$/, '')}/c/${encodeURIComponent(code)}`;
}
