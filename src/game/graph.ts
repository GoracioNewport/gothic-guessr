/**
 * Node lookup, link helpers and yaw/pitch conversion for the waypoint graph.
 * Pure functions over the manifest; no DOM, no viewer imports.
 */
import type { GameCoords, Location, Manifest, ManifestLink, ManifestNode } from '../contracts';

/** Node by id; throws if the id is not an integer index into `manifest.nodes`. */
export function getNode(manifest: Manifest, id: number): ManifestNode {
  const node = Number.isInteger(id) ? manifest.nodes[id] : undefined;
  if (!node) throw new Error(`graph: node ${id} does not exist (${manifest.nodes.length} nodes)`);
  return node;
}

/** True when `id` is a valid node id. */
export function hasNode(manifest: Manifest, id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < manifest.nodes.length;
}

/** Horizontal position of a node as {x, z}. */
export function nodeCoords(node: ManifestNode): GameCoords {
  return { x: node.x, z: node.z };
}

// ---------------------------------------------------------------------------------------------
// Several worlds (stage 2): a location is {world, nodeId}; `worlds` maps slug → {manifest}
// ---------------------------------------------------------------------------------------------

/** Anything that can hand out a manifest per world slug (the `worlds` map of `loadWorlds()`). */
export type WorldManifests = ReadonlyMap<string, { manifest: Manifest }>;

/** Manifest of a world; throws when the slug is not loaded. */
export function getManifest(worlds: WorldManifests, world: string): Manifest {
  const entry = worlds.get(world);
  if (!entry) throw new Error(`graph: world "${world}" is not loaded (${[...worlds.keys()].join(', ') || 'none'})`);
  return entry.manifest;
}

/** Node at a location; throws when the world is not loaded or the node id does not exist there. */
export function getNodeAt(worlds: WorldManifests, loc: Location): ManifestNode {
  return getNode(getManifest(worlds, loc.world), loc.nodeId);
}

/** True when `loc.world` is loaded and `loc.nodeId` is a node of it. */
export function hasLocation(worlds: WorldManifests, loc: Location): boolean {
  const entry = worlds.get(loc.world);
  return entry !== undefined && hasNode(entry.manifest, loc.nodeId);
}

/** Horizontal position of a location in its world's game coordinates. */
export function locationCoords(worlds: WorldManifests, loc: Location): GameCoords {
  return nodeCoords(getNodeAt(worlds, loc));
}

/** True when both locations name the same node of the same world. */
export function sameLocation(a: Location, b: Location): boolean {
  return a.world === b.world && a.nodeId === b.nodeId;
}

/** Ids of the nodes reachable from `nodeId` in one step, in manifest order. */
export function neighbours(manifest: Manifest, nodeId: number): number[] {
  return getNode(manifest, nodeId).links.map((l) => l.to);
}

/** The link `from → to`, or undefined when the nodes are not adjacent. */
export function findLink(manifest: Manifest, from: number, to: number): ManifestLink | undefined {
  return getNode(manifest, from).links.find((l) => l.to === to);
}

/**
 * True when `from → to` is a walkable edge: both ids exist, the edge is listed on `from`, and the
 * target is not the node itself. Use it to reject arrow clicks or programmatic moves that are not
 * in the graph.
 */
export function isValidLink(manifest: Manifest, from: number, to: number): boolean {
  return hasNode(manifest, from) && hasNode(manifest, to) && from !== to && findLink(manifest, from, to) !== undefined;
}

/**
 * Number of edges on the shortest path from `from` to `to`, or -1 when unreachable.
 * Breadth-first search over the whole graph; meant for tests and debugging, not the hot path.
 */
export function bfsDistance(manifest: Manifest, from: number, to: number): number {
  getNode(manifest, from);
  getNode(manifest, to);
  if (from === to) return 0;
  const dist = new Map<number, number>([[from, 0]]);
  const queue: number[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!;
    const d = dist.get(id)!;
    for (const next of neighbours(manifest, id)) {
      if (dist.has(next)) continue;
      if (next === to) return d + 1;
      dist.set(next, d + 1);
      queue.push(next);
    }
  }
  return -1;
}

/** Ids of every node reachable from `from` (including `from` itself). */
export function reachableNodes(manifest: Manifest, from: number): Set<number> {
  const seen = new Set<number>([from]);
  const queue: number[] = [from];
  for (let head = 0; head < queue.length; head++) {
    for (const next of neighbours(manifest, queue[head]!)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// Viewer link conversion
// ---------------------------------------------------------------------------------------------

/**
 * One link in the shape the virtual-tour plugin expects for `positionMode: 'manual'`:
 * `nodeId` is the plugin's string id of the target node, `position` is in viewer radians.
 * `dist` (metres) is carried along so the panorama module can scale arrows if it wants.
 */
export interface ViewerLink {
  nodeId: string;
  position: { yaw: number; pitch: number };
  dist: number;
}

/** Angle converters injected into {@link nodeToViewerLinks}. */
export interface AngleConverters {
  /** Manifest yaw (degrees clockwise from north) → viewer yaw (radians). */
  yaw: (deg: number) => number;
  /** Manifest pitch (degrees above the horizon) → viewer pitch (radians). Defaults to deg→rad. */
  pitch?: (deg: number) => number;
}

/** Plugin node id for a manifest node id (the plugin wants strings). */
export function viewerNodeId(id: number): string {
  return String(id);
}

/** Manifest node id for a plugin node id; throws on anything that is not a non-negative integer. */
export function manifestNodeId(viewerId: string): number {
  if (!/^\d+$/.test(viewerId)) throw new Error(`graph: bad viewer node id "${viewerId}"`);
  return Number(viewerId);
}

/**
 * Convert a manifest node's links into the plugin's link list. The yaw convention of the viewer
 * is deliberately not decided here: the panorama module passes its own converter (it owns the
 * empirical sign check, see SPEC.md section 3), typically {@link gameYawToViewerYaw}.
 * Links pointing at nodes outside the manifest are dropped.
 */
export function nodeToViewerLinks(manifest: Manifest, node: ManifestNode, convert: AngleConverters): ViewerLink[] {
  const toPitch = convert.pitch ?? gamePitchToViewerPitch;
  return node.links
    .filter((l) => hasNode(manifest, l.to))
    .map((l) => ({
      nodeId: viewerNodeId(l.to),
      position: { yaw: convert.yaw(l.yaw), pitch: toPitch(l.pitch) },
      dist: l.dist,
    }));
}

// ---------------------------------------------------------------------------------------------
// Angle conversion
// ---------------------------------------------------------------------------------------------

const DEG = Math.PI / 180;
const TAU = 2 * Math.PI;

/**
 * Convert manifest yaw (degrees clockwise from north, north = front-face centre) into Photo Sphere
 * Viewer yaw (radians in [0, 2π), 0 = front-face centre).
 *
 * Assumed rule: clockwise-from-north maps to viewer yaw with the same sign, i.e. a link at 90°
 * (east) appears to the right of the front face. This matches Photo Sphere Viewer's documented
 * convention (yaw grows to the right), but the cube-map adapter can mirror it; the panorama
 * module verifies the sign at the harbour sample (SPEC.md section 3, docs/VIEWER_NOTES.md) and
 * is the authority if the two disagree.
 */
export function gameYawToViewerYaw(deg: number): number {
  const rad = deg * DEG;
  return ((rad % TAU) + TAU) % TAU;
}

/** Convert manifest pitch (degrees above the horizon) into viewer pitch (radians, up = positive). */
export function gamePitchToViewerPitch(deg: number): number {
  return deg * DEG;
}
