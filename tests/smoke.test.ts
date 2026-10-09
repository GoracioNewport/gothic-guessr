import { describe, expect, it } from 'vitest';
import type { GameCoords, Manifest, RoundResult, WorldGuess } from '../src/contracts';
import { validateManifest } from '../src/data/manifest';

/** Smallest manifest that passes validation; tests tweak a copy of it. */
function minimal(): Record<string, unknown> {
  return {
    world: 'w', name: 'W', units: 'cm', eyeHeight: 180,
    pano: { faceSize: 2048, tileSize: 1024, nbTiles: 2, baseSize: 512, path: 'panos/{id}',
      base: 'base_{face}.webp', tile: '{face}_{col}_{row}.webp',
      faces: ['front', 'right', 'back', 'left', 'top', 'bottom'] },
    map: { path: 'map/{z}/{x}/{y}.webp', tileSize: 256, width: 2048, height: 1024, maxZoom: 3,
      frame: { x0: -1000, z0: 1000, x1: 1000, z1: -1000 } },
    scoring: { maxScore: 5000, perfectRadiusM: 15, diagonalM: 1546 },
    nodes: [
      { id: 0, wp: 'A', x: 0, y: 0, z: 0, outdoor: true, links: [{ to: 1, yaw: 90, pitch: 0, dist: 5 }] },
      { id: 1, wp: 'B', x: 500, y: 0, z: 0, outdoor: true, links: [{ to: 0, yaw: 270, pitch: 0, dist: 5 }] },
    ],
    starts: [0, 1],
  };
}

describe('contracts', () => {
  it('shape of GameCoords, WorldGuess and RoundResult compiles', () => {
    const point: GameCoords = { x: 0, z: 0 };
    const guess: WorldGuess = { world: 'w', ...point };
    const result: RoundResult = {
      round: 1, guess, answer: { x: 100, z: 0 }, guessWorld: 'w', answerWorld: 'w', answerNodeId: 0, distanceM: 1, score: 5000,
    };
    const wrongWorld: RoundResult = { ...result, guessWorld: 'other', distanceM: null, score: 0 };
    expect(result.round).toBe(1);
    expect(wrongWorld.distanceM).toBeNull();
  });
});

describe('validateManifest', () => {
  it('accepts a minimal manifest', () => {
    const m: Manifest = validateManifest(minimal());
    expect(m.nodes[0]?.wp).toBe('A');
  });

  it('rejects a node with a wrong id', () => {
    const m = minimal();
    (m.nodes as Array<{ id: number }>)[0]!.id = 1;
    expect(() => validateManifest(m)).toThrow(/nodes\[0\]\.id/);
  });

  it('rejects scoring without the numbers the formula needs', () => {
    expect(() => validateManifest({ ...minimal(), scoring: {} })).toThrow(/scoring\.maxScore/);
    expect(() => validateManifest({ ...minimal(), scoring: { maxScore: 5000, perfectRadiusM: 15, diagonalM: 0 } }))
      .toThrow(/scoring\.diagonalM/);
  });

  it('rejects a map without size or with a degenerate frame', () => {
    const m = minimal();
    const map = m.map as Record<string, unknown>;
    expect(() => validateManifest({ ...m, map: { ...map, width: undefined } })).toThrow(/map\.width/);
    expect(() => validateManifest({ ...m, map: { ...map, frame: { x0: 0, z0: 0, x1: 0, z1: 0 } } }))
      .toThrow(/map\.frame/);
  });

  it('rejects a dangling link', () => {
    const m = minimal();
    (m.nodes as Array<{ links: Array<{ to: number }> }>)[0]!.links[0]!.to = 99;
    expect(() => validateManifest(m)).toThrow(/nodes\[0\]\.links\[0\]\.to = 99/);
  });

  it('rejects a start node outside map.frame', () => {
    const m = minimal();
    (m.nodes as Array<{ z: number }>)[1]!.z = -1001;
    expect(() => validateManifest(m)).toThrow(/start 1 \(B\).*outside map\.frame/);
  });
});
