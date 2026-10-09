import { describe, expect, it } from 'vitest';
import type { ManifestScoring } from '../src/contracts';
import type { Manifest } from '../src/contracts';
import { distanceMetres, scoreForCoords, scoreForDistance, scoreForGuess, totalScore } from '../src/game/scoring';

// Values from SPEC.md section 5 (and the real manifest).
const scoring: ManifestScoring = { maxScore: 5000, perfectRadiusM: 15, diagonalM: 1546 };
// SPEC.md section 5 lists 155 m → 1835, 50 m → 3618, 300 m → 718 for diagonal 1546; an earlier
// revision of the spec had 1839 / 3620 / 722, which is what diagonal 1550 gives.
const specExample: ManifestScoring = { ...scoring, diagonalM: 1550 };

describe('distanceMetres', () => {
  it('converts centimetres to metres on the X/Z plane', () => {
    expect(distanceMetres({ x: 0, z: 0 }, { x: 300, z: 400 })).toBe(5);
    expect(distanceMetres({ x: -1385.1, z: 3172.4 }, { x: -1385.1, z: 3172.4 })).toBe(0);
  });

  it('is symmetric', () => {
    const a = { x: 12345, z: -678 };
    const b = { x: -200, z: 9999 };
    expect(distanceMetres(a, b)).toBe(distanceMetres(b, a));
  });
});

describe('scoreForDistance', () => {
  it('reproduces the old worked examples (diagonal 1550)', () => {
    expect(scoreForDistance(155, specExample)).toBe(1839);
    expect(scoreForDistance(300, specExample)).toBe(722);
    expect(Math.abs(scoreForDistance(50, specExample) - 3620)).toBeLessThanOrEqual(1);
  });

  it('reproduces the SPEC.md examples for the manifest diagonal 1546', () => {
    expect(scoreForDistance(155, scoring)).toBe(1835);
    expect(scoreForDistance(50, scoring)).toBe(3618);
    expect(scoreForDistance(300, scoring)).toBe(718);
    for (const [d, spec] of [[155, 1839], [50, 3620], [300, 722]] as const) {
      expect(Math.abs(scoreForDistance(d, scoring) - spec)).toBeLessThanOrEqual(5);
    }
  });

  it('gives maxScore within the perfect radius', () => {
    expect(scoreForDistance(0, scoring)).toBe(5000);
    expect(scoreForDistance(15, scoring)).toBe(5000);
    expect(scoreForDistance(15.01, scoring)).toBeLessThan(5000);
  });

  it('never exceeds maxScore, never goes negative, decreases with distance', () => {
    let prev = scoring.maxScore;
    for (let d = 0; d <= 5000; d += 25) {
      const s = scoreForDistance(d, scoring);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(scoring.maxScore);
      expect(s).toBeLessThanOrEqual(prev);
      prev = s;
    }
    expect(scoreForDistance(10_000, scoring)).toBe(0);
  });

  it('handles bad input defensively', () => {
    expect(scoreForDistance(-5, scoring)).toBe(5000);
    expect(scoreForDistance(Number.NaN, scoring)).toBe(0);
    expect(scoreForDistance(Number.POSITIVE_INFINITY, scoring)).toBe(0);
  });
});

describe('scoreForCoords / totalScore', () => {
  it('scores a guess from game coordinates', () => {
    // 15500 cm = 155 m
    expect(scoreForCoords({ x: 0, z: 0 }, { x: 15500, z: 0 }, specExample)).toBe(1839);
    expect(scoreForCoords({ x: 0, z: 0 }, { x: 15500, z: 0 }, scoring)).toBe(1835);
  });

  it('sums round scores, max 25000 over 5 rounds', () => {
    expect(totalScore([])).toBe(0);
    expect(totalScore([{ score: 5000 }, { score: 5000 }, { score: 5000 }, { score: 5000 }, { score: 5000 }])).toBe(25000);
    expect(totalScore([{ score: 1839 }, { score: 722 }])).toBe(2561);
  });
});

/** Two-node world `slug` with the given scoring; node 1 sits 155 m east of node 0. */
function world(slug: string, sc: ManifestScoring = scoring): Manifest {
  return {
    world: slug, name: slug.toUpperCase(), units: 'cm', eyeHeight: 180,
    pano: { faceSize: 2048, tileSize: 1024, nbTiles: 2, baseSize: 512, path: 'panos/{id}', base: 'base_{face}.webp',
      tile: '{face}_{col}_{row}.webp', faces: ['front', 'right', 'back', 'left', 'top', 'bottom'] },
    map: { path: 'map/{z}/{x}/{y}.webp', tileSize: 256, width: 1024, height: 1024, maxZoom: 2,
      frame: { x0: -100000, z0: 100000, x1: 100000, z1: -100000 } },
    scoring: sc,
    nodes: [
      { id: 0, wp: 'A', x: 0, y: 0, z: 0, outdoor: true, links: [] },
      { id: 1, wp: 'B', x: 15500, y: 0, z: 0, outdoor: true, links: [] },
    ],
    starts: [0, 1],
  };
}

describe('scoreForGuess (worlds, SPEC 9.5)', () => {
  const khorinis = world('khorinis');
  const valley = world('valley', specExample);

  it('same world: distance and score from the answer world\'s manifest', () => {
    expect(scoreForGuess({ world: 'khorinis', x: 0, z: 0 }, { world: 'khorinis', nodeId: 1 }, khorinis))
      .toEqual({ sameWorld: true, distanceM: 155, score: 1835 });
    // The valley manifest has the other diagonal, so the same miss scores 1839 there.
    expect(scoreForGuess({ world: 'valley', x: 0, z: 0 }, { world: 'valley', nodeId: 1 }, valley))
      .toEqual({ sameWorld: true, distanceM: 155, score: 1839 });
    expect(scoreForGuess({ world: 'khorinis', x: 15500, z: 10 }, { world: 'khorinis', nodeId: 1 }, khorinis).score).toBe(5000);
  });

  it('wrong world: score 0 and distanceM null, whatever the coordinates', () => {
    // Guess exactly on the answer's coordinates, but on the other world's map.
    expect(scoreForGuess({ world: 'valley', x: 15500, z: 0 }, { world: 'khorinis', nodeId: 1 }, khorinis))
      .toEqual({ sameWorld: false, distanceM: null, score: 0 });
    expect(scoreForGuess({ world: 'jharkendar', x: 0, z: 0 }, { world: 'valley', nodeId: 0 }, valley).score).toBe(0);
  });

  it('rejects a manifest of the wrong world or a missing node', () => {
    expect(() => scoreForGuess({ world: 'valley', x: 0, z: 0 }, { world: 'valley', nodeId: 0 }, khorinis))
      .toThrow(/manifest is for "khorinis", the answer is in "valley"/);
    expect(() => scoreForGuess({ world: 'khorinis', x: 0, z: 0 }, { world: 'khorinis', nodeId: 7 }, khorinis))
      .toThrow(/node 7 does not exist/);
  });
});
