/**
 * Synthetic fixture worlds for server tests (the real dataset may be absent or mid-migration).
 *
 * A world is a `cols × rows` grid of nodes 100 m apart (10 000 game cm), each linked to its 4-neighbours with proper
 * yaw (0 = +Z north, 90 = +X east), plus one isolated technical node at the end (not a start). Odd ids are indoor.
 * Keys are `<slug><4-digit id>`, e.g. `alpha0007`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest, ManifestLink } from '../../../src/contracts';
import { buildRegistry, buildWorld } from '../../../server/core/worlds';
import type { PrivateManifest, PrivateNode, WorldRegistry } from '../../../server/core/worlds';

export const SPACING_CM = 10_000;

export function fixtureKey(slug: string, id: number): string {
  return `${slug}${String(id).padStart(4, '0')}`;
}

export function fixtureManifest(slug: string, cols: number, rows: number): PrivateManifest {
  const nodes: PrivateNode[] = [];
  const idAt = (c: number, r: number): number => r * cols + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = idAt(c, r);
      const links: ManifestLink[] = [];
      const add = (cc: number, rr: number, yaw: number): void => {
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) return;
        links.push({ to: idAt(cc, rr), yaw, pitch: 0, dist: SPACING_CM / 100 });
      };
      add(c, r + 1, 0); // north (+z)
      add(c + 1, r, 90); // east (+x)
      add(c, r - 1, 180);
      add(c - 1, r, 270);
      nodes.push({
        id,
        key: fixtureKey(slug, id),
        wp: `${slug.toUpperCase()}_WP_${id}`,
        x: c * SPACING_CM,
        y: 0,
        z: r * SPACING_CM,
        outdoor: id % 2 === 0,
        links,
      });
    }
  }
  const isolated = nodes.length;
  nodes.push({ id: isolated, key: fixtureKey(slug, isolated), wp: 'TOT', x: 0, y: 0, z: 0, outdoor: true, links: [] });
  return {
    world: slug,
    name: slug[0]!.toUpperCase() + slug.slice(1),
    units: 'cm',
    eyeHeight: 180,
    pano: {
      faceSize: 2048,
      tileSize: 1024,
      nbTiles: 2,
      baseSize: 512,
      path: 'panos/{key}',
      base: 'base_{face}.webp',
      tile: '{face}_{col}_{row}.webp',
      faces: ['front', 'right', 'back', 'left', 'top', 'bottom'],
    },
    map: {
      path: 'map/{z}/{x}/{y}.webp',
      tileSize: 256,
      width: 1024,
      height: 1024,
      maxZoom: 2,
      frame: { x0: -SPACING_CM, z0: rows * SPACING_CM, x1: cols * SPACING_CM, z1: -SPACING_CM },
    },
    scoring: { maxScore: 5000, perfectRadiusM: 15, diagonalM: 1546 },
    nodes,
    starts: nodes.slice(0, isolated).map((n) => n.id),
  };
}

/** `alpha` (5×4 = 20 starts) and `beta` (3×3 = 9 starts), in that display order. */
export function fixtureManifests(): PrivateManifest[] {
  return [fixtureManifest('alpha', 5, 4), fixtureManifest('beta', 3, 3)];
}

export function fixtureRegistry(manifests: Manifest[] = fixtureManifests()): WorldRegistry {
  return buildRegistry(manifests.map((m) => buildWorld(m.world, m.name, m)));
}

/** Write the fixture as on disk: `<dataDir>/worlds.json` and `<serverDataDir>/<slug>/manifest.json`. */
export function writeFixtureDataset(dataDir: string, serverDataDir: string, manifests: Manifest[] = fixtureManifests()): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, 'worlds.json'),
    JSON.stringify({
      worlds: manifests.map((m) => ({ slug: m.world, name: m.name, description: '', world: `${m.world}/world.json`, thumbnail: '' })),
    }),
  );
  for (const m of manifests) {
    mkdirSync(join(serverDataDir, m.world), { recursive: true });
    writeFileSync(join(serverDataDir, m.world, 'manifest.json'), JSON.stringify(m));
  }
}
