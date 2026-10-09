import { describe, expect, it } from 'vitest';
import { validateManifest } from '../src/data/manifest';
import { readDataset } from './dataset';
import { getNode } from '../src/game/graph';
import { gameToPixel } from '../src/ui/mapcoords';

const manifestJson: unknown = readDataset('server-data/khorinis/manifest.json');

// Review regression test (game-logic lens): every round answer must be drawable on the guess map.
// The result screen puts the answer pin at gameToPixel(answer); a start node outside `map.frame`
// lands off the island image, in the blank sea padding, which is what the player sees as a pin
// "next to" the map (e.g. seed 176, round 1: NW_PASS_ORKS_10, z = -42654 < frame.z1 = -42500).
const manifest = validateManifest(manifestJson as unknown, 'khorinis/manifest.json');

describe('starts lie inside the map frame', () => {
  it('every start node maps to a pixel within the full-resolution map image', () => {
    const { width, height } = manifest.map;
    const outside = manifest.starts
      .map((id) => getNode(manifest, id))
      .filter((n) => {
        const { px, py } = gameToPixel(manifest.map, { x: n.x, z: n.z });
        return px < 0 || py < 0 || px > width || py > height;
      })
      .map((n) => `${n.id} ${n.wp} (x=${n.x}, z=${n.z})`);
    expect(outside, 'starts outside map.frame').toEqual([]);
  });
});
