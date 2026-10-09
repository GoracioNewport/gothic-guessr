/**
 * Duel rules (SPEC §10.1, §10.6): GeoGuessr-style health for a room of exactly two players. Pure, no I/O, no clock of
 * its own: every time-dependent function takes `now`. The room state machine (core/party.ts) owns the round flow and
 * delegates every duel-specific decision here through a {@link DuelMatch}.
 *
 *   - Both players start with {@link DUEL_START_HP} HP.
 *   - Each round the player with the lower round score loses `(higher − lower) × multiplier` HP (rounded to an
 *     integer, never below 0); multiplier ×1 for rounds 1–3, then +0.5 per round (r4 ×1.5, r5 ×2, …).
 *   - Once the first player guesses, the other has {@link DUEL_COUNTDOWN_MS} (or the remaining round time if shorter).
 *   - Base round limit: the room's time limit, default off; a hard cap of {@link DUEL_HARD_CAP_S} always applies.
 *   - The match ends when someone reaches 0 HP; after the last round (30, or fewer when the chosen worlds have fewer
 *     start nodes) the higher HP wins and equal HP is a draw.
 *   - A player disconnected for more than {@link DUEL_FORFEIT_MS} forfeits (the earlier disconnect loses when both
 *     are away); leaving the room during a match forfeits at once.
 */
import { DUEL_HARD_CAP_S, DUEL_MAX_ROUNDS } from './settings';

export const DUEL_START_HP = 6000;
/** Time the second player gets after the first guess. */
export const DUEL_COUNTDOWN_MS = 15_000;
/** A player disconnected longer than this forfeits. */
export const DUEL_FORFEIT_MS = 60_000;
/** Pause between a round result and the next round (the host may skip it with `next`). */
export const DUEL_RESULT_MS = 10_000;
export { DUEL_HARD_CAP_S, DUEL_MAX_ROUNDS };

/** Damage multiplier of round `n` (1-based): ×1 for rounds 1–3, then +0.5 per round. */
export function duelMultiplier(n: number): number {
  return n <= 3 ? 1 : 1 + 0.5 * (n - 3);
}

/** Base deadline of a duel round: the time limit when set, capped at {@link DUEL_HARD_CAP_S}. */
export function duelRoundDeadline(startedAt: number, timeLimitS: number): number {
  const limit = timeLimitS > 0 ? Math.min(timeLimitS, DUEL_HARD_CAP_S) : DUEL_HARD_CAP_S;
  return startedAt + limit * 1000;
}

/** Deadline after the first guess at `now`: 15 s later, never later than the current deadline. */
export function duelCountdownDeadline(now: number, deadline: number | null): number {
  const countdown = now + DUEL_COUNTDOWN_MS;
  return deadline === null ? countdown : Math.min(deadline, countdown);
}

export interface DuelRoundOutcome {
  n: number;
  multiplier: number;
  /** HP after the round. */
  hp: Record<string, number>;
  /** HP lost this round per player (0 for the winner of the round). */
  damage: Record<string, number>;
  /** The match is decided (KO or last round). */
  over: boolean;
  /** Winner when `over`: player id, or null for a draw. */
  winner: string | null;
}

/** HP bookkeeping of one duel match. */
export class DuelMatch {
  readonly players: readonly [string, string];
  readonly maxRounds: number;
  private readonly hpById = new Map<string, number>();
  private forfeitedBy: string | null = null;

  /** `maxRounds`: rounds the challenge actually has (30, or fewer with few start nodes). */
  constructor(players: readonly string[], maxRounds = DUEL_MAX_ROUNDS) {
    if (players.length !== 2 || players[0] === players[1]) throw new Error('duel: exactly two distinct players');
    this.players = [players[0]!, players[1]!];
    this.maxRounds = Math.max(1, Math.min(DUEL_MAX_ROUNDS, Math.floor(maxRounds)));
    for (const p of this.players) this.hpById.set(p, DUEL_START_HP);
  }

  hp(): Record<string, number> {
    return Object.fromEntries(this.players.map((p) => [p, this.hpById.get(p)!]));
  }

  hpOf(playerId: string): number | undefined {
    return this.hpById.get(playerId);
  }

  opponentOf(playerId: string): string | null {
    if (playerId === this.players[0]) return this.players[1];
    if (playerId === this.players[1]) return this.players[0];
    return null;
  }

  /** Who forfeited, if anyone. */
  get forfeited(): string | null {
    return this.forfeitedBy;
  }

  /**
   * Apply round `n` with both players' round scores (a missing score counts as 0). Returns the new HP, the damage
   * and whether the match is decided.
   */
  applyRound(n: number, scores: Readonly<Record<string, number>>): DuelRoundOutcome {
    const multiplier = duelMultiplier(n);
    const [a, b] = this.players;
    const sa = scores[a] ?? 0;
    const sb = scores[b] ?? 0;
    const damage: Record<string, number> = { [a]: 0, [b]: 0 };
    if (sa !== sb) {
      const loser = sa < sb ? a : b;
      const dealt = Math.round(Math.abs(sa - sb) * multiplier);
      const before = this.hpById.get(loser)!;
      const after = Math.max(0, before - dealt);
      this.hpById.set(loser, after);
      damage[loser] = before - after;
    }
    const hp = this.hp();
    const ko = this.players.find((p) => hp[p]! <= 0) ?? null;
    if (ko !== null) return { n, multiplier, hp, damage, over: true, winner: this.opponentOf(ko) };
    if (n >= this.maxRounds) return { n, multiplier, hp, damage, over: true, winner: this.leader() };
    return { n, multiplier, hp, damage, over: false, winner: null };
  }

  /** Higher HP, or null when equal. */
  leader(): string | null {
    const [a, b] = this.players;
    const ha = this.hpById.get(a)!;
    const hb = this.hpById.get(b)!;
    return ha === hb ? null : ha > hb ? a : b;
  }

  /** Record a forfeit; returns the winner. */
  forfeit(playerId: string): string {
    const winner = this.opponentOf(playerId);
    if (winner === null) throw new Error(`duel: ${playerId} is not in this match`);
    this.forfeitedBy ??= playerId;
    return winner;
  }
}

/**
 * The player who forfeits by disconnect at `now`: away longer than {@link DUEL_FORFEIT_MS}; with both away, the one
 * who left first. Null when nobody does.
 */
export function duelForfeiter(
  players: readonly { id: string; connected: boolean; disconnectedAt: number | null }[],
  now: number,
): string | null {
  let worst: { id: string; at: number } | null = null;
  for (const p of players) {
    if (p.connected || p.disconnectedAt === null) continue;
    if (now - p.disconnectedAt <= DUEL_FORFEIT_MS) continue;
    if (!worst || p.disconnectedAt < worst.at) worst = { id: p.id, at: p.disconnectedAt };
  }
  return worst?.id ?? null;
}

/** When the next disconnect forfeit could happen (for timers), or null. */
export function duelForfeitWakeAt(players: readonly { connected: boolean; disconnectedAt: number | null }[]): number | null {
  let at: number | null = null;
  for (const p of players) {
    if (p.connected || p.disconnectedAt === null) continue;
    const t = p.disconnectedAt + DUEL_FORFEIT_MS + 1;
    if (at === null || t < at) at = t;
  }
  return at;
}
