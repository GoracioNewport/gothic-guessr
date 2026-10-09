/**
 * Leaderboard ordering (SPEC §10.4): finished games only, banned players and hidden entries excluded (the repository
 * filters), order by total desc, total time asc, finish time asc (game id as the last, stable tie-break). Pure.
 * The SQL in server/db/repository.ts implements the same order; tests check both agree.
 */

export interface RankedRow {
  gameId: string;
  total: number;
  timeMs: number;
  finishedAt: number;
}

/** Comparator: negative when `a` ranks above `b`. */
export function compareLeaderboard(a: RankedRow, b: RankedRow): number {
  return b.total - a.total || a.timeMs - b.timeMs || a.finishedAt - b.finishedAt || (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0);
}

/** Sort a copy and assign ranks 1..n (positions; ties are already broken by finish time). */
export function rankRows<T extends RankedRow>(rows: readonly T[]): (T & { rank: number })[] {
  return [...rows].sort(compareLeaderboard).map((r, i) => ({ ...r, rank: i + 1 }));
}
