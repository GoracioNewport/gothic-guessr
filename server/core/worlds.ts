/**
 * Server-side world registry (pure). A world is the PRIVATE manifest of SPEC §10.3 (`server-data/<slug>/manifest.json`:
 * the stage-2 manifest plus `nodes[i].key`) together with lookups by key. Loading from disk lives in server/worlds.ts.
 *
 * The registry is a `Map<slug, ServerWorld>` in worlds.json order, so it is directly usable as the `WorldManifests`
 * argument of `pickRounds` (src/game/state.ts) and `getManifest` (src/game/graph.ts).
 */
import type { Manifest, ManifestNode } from '../../src/contracts';
import type { PanoNode } from '../../shared/api';

/** A node of a private manifest: has the opaque public key used in URLs and the API. */
export interface PrivateNode extends ManifestNode {
  key: string;
}

export interface PrivateManifest extends Manifest {
  nodes: PrivateNode[];
}

export interface ServerWorld {
  slug: string;
  /** Display name from worlds.json (English; the client localizes). */
  name: string;
  manifest: PrivateManifest;
  /** key → node id. */
  idByKey: Map<string, number>;
}

/** Slug → world, iteration order = worlds.json order. */
export type WorldRegistry = ReadonlyMap<string, ServerWorld>;

/** Build a world entry; throws when a node lacks a key or two nodes share one. */
export function buildWorld(slug: string, name: string, manifest: Manifest): ServerWorld {
  const idByKey = new Map<string, number>();
  manifest.nodes.forEach((node, i) => {
    const key = (node as Partial<PrivateNode>).key;
    if (typeof key !== 'string' || !/^[a-z0-9]{6,32}$/.test(key)) {
      throw new Error(`world ${slug}: nodes[${i}] has no valid "key" (is this the private manifest?)`);
    }
    if (idByKey.has(key)) throw new Error(`world ${slug}: duplicate node key ${key}`);
    idByKey.set(key, i);
  });
  if (manifest.world !== slug) throw new Error(`world ${slug}: manifest.world is "${manifest.world}"`);
  return { slug, name, manifest: manifest as PrivateManifest, idByKey };
}

/** Registry from entries in display order; throws on a duplicate slug or on keys shared between worlds. */
export function buildRegistry(worlds: readonly ServerWorld[]): WorldRegistry {
  const map = new Map<string, ServerWorld>();
  const owner = new Map<string, string>();
  for (const w of worlds) {
    if (map.has(w.slug)) throw new Error(`worlds: duplicate slug ${w.slug}`);
    for (const key of w.idByKey.keys()) {
      const other = owner.get(key);
      if (other !== undefined) throw new Error(`worlds: key ${key} exists in ${other} and ${w.slug}`);
      owner.set(key, w.slug);
    }
    map.set(w.slug, w);
  }
  return map;
}

/** Slugs in display order. */
export function worldSlugs(worlds: WorldRegistry): string[] {
  return [...worlds.keys()];
}

/** World or throw (internal error: a stored game references a world that is no longer loaded). */
export function requireWorld(worlds: WorldRegistry, slug: string): ServerWorld {
  const w = worlds.get(slug);
  if (!w) throw new Error(`worlds: world "${slug}" is not loaded`);
  return w;
}

/** Node of a world by key, or undefined. */
export function nodeByKey(world: ServerWorld, key: string): PrivateNode | undefined {
  const id = world.idByKey.get(key);
  return id === undefined ? undefined : world.manifest.nodes[id];
}

/** Node of a world by key or throw (internal). */
export function requireNodeByKey(world: ServerWorld, key: string): PrivateNode {
  const node = nodeByKey(world, key);
  if (!node) throw new Error(`worlds: key ${key} is not a node of ${world.slug}`);
  return node;
}

/**
 * The player-facing form of a node: its key and the links (target key, yaw, pitch) — no coordinates, no `dist`, no
 * waypoint name. `withLinks: false` (No move) returns no links at all.
 */
export function toPanoNode(world: ServerWorld, node: PrivateNode, withLinks = true): PanoNode {
  const nodes = world.manifest.nodes;
  return {
    key: node.key,
    links: withLinks
      ? node.links.filter((l) => nodes[l.to] !== undefined).map((l) => ({ key: nodes[l.to]!.key, yaw: l.yaw, pitch: l.pitch }))
      : [],
  };
}
