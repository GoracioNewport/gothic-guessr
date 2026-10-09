/**
 * Pure scoring functions (SPEC.md section 5). No DOM, no state.
 */
import type { GameCoords, Location, Manifest, ManifestScoring, RoundResult, WorldGuess } from '../contracts';
import { getNode, nodeCoords } from './graph';

/** Game units (centimetres) per metre. */
const CM_PER_M = 100;

/** Horizontal distance between two game points in metres (game units are centimetres). */
export function distanceMetres(a: GameCoords, b: GameCoords): number {
  return Math.hypot(a.x - b.x, a.z - b.z) / CM_PER_M;
}

/**
 * Score for a miss of `distanceM` metres:
 * `distanceM <= perfectRadiusM ? maxScore : round(maxScore * exp(-10 * distanceM / diagonalM))`.
 * Negative or non-finite distances are treated as 0 / infinitely far respectively.
 */
export function scoreForDistance(distanceM: number, scoring: ManifestScoring): number {
  if (Number.isNaN(distanceM) || distanceM === Infinity) return 0;
  const d = Math.max(0, distanceM);
  if (d <= scoring.perfectRadiusM) return scoring.maxScore;
  return Math.round(scoring.maxScore * Math.exp((-10 * d) / scoring.diagonalM));
}

/** Score for a guess against an answer in the same world, both in game coordinates. */
export function scoreForCoords(guess: GameCoords, answer: GameCoords, scoring: ManifestScoring): number {
  return scoreForDistance(distanceMetres(guess, answer), scoring);
}

/** Distance and score of one guess (SPEC.md section 9.5). */
export interface GuessScore {
  /** True when the marker was placed on the answer's world. */
  sameWorld: boolean;
  /** Metres between guess and answer, or `null` for a wrong-world guess. */
  distanceM: number | null;
  /** 0..`maxScore`; 0 for a wrong-world guess. */
  score: number;
}

/**
 * Score a guess `{world, x, z}` against the round's start node `{world, nodeId}` using the
 * manifest of the **answer's** world (its node coordinates and `scoring` constants).
 * A guess on another world scores 0 with `distanceM: null` (SPEC.md section 9.5); the caller
 * tells the player "Wrong world — it was <name>". Throws if `answer.nodeId` is not in `manifest`
 * or `manifest.world` does not match `answer.world`.
 */
export function scoreForGuess(guess: WorldGuess, answer: Location, manifest: Manifest): GuessScore {
  if (manifest.world !== answer.world) {
    throw new Error(`scoring: manifest is for "${manifest.world}", the answer is in "${answer.world}"`);
  }
  if (guess.world !== answer.world) return { sameWorld: false, distanceM: null, score: 0 };
  const distanceM = distanceMetres(guess, nodeCoords(getNode(manifest, answer.nodeId)));
  return { sameWorld: true, distanceM, score: scoreForDistance(distanceM, manifest.scoring) };
}

/** Sum of round scores. */
export function totalScore(rounds: readonly Pick<RoundResult, 'score'>[]): number {
  return rounds.reduce((sum, r) => sum + r.score, 0);
}
