/**
 * Manifest loader. Types live in src/contracts.ts; this module only fetches and validates.
 */
import type { Manifest } from '../contracts';

export type { Manifest, ManifestNode, ManifestLink } from '../contracts';

/** Base URL of the static data directory (`VITE_DATA_BASE`, default `/data`), without trailing slash. */
export function dataBase(): string {
  const base = (import.meta.env?.VITE_DATA_BASE as string | undefined) ?? '/data';
  return base.replace(/\/+$/, '');
}

/** Base URL of one world's directory, e.g. `/data/khorinis`. Pano and map paths are relative to it. */
export function worldBase(world: string): string {
  return `${dataBase()}/${world}`;
}

/** URL of a world's manifest.json. */
export function manifestUrl(world: string): string {
  return `${worldBase(world)}/manifest.json`;
}

/**
 * Fetch and validate a manifest. Throws with a readable message on any problem, so a broken
 * dataset fails at load time instead of producing NaN scores or viewer errors mid-game.
 */
export async function loadManifest(url: string): Promise<Manifest> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`manifest: HTTP ${res.status} for ${url}`);
  const data: unknown = await res.json();
  return validateManifest(data, url);
}

/**
 * Validate a parsed JSON value as a Manifest. Checks every field the game reads: the pano/map/
 * scoring numbers, node ids equal to their index, link targets in range, and start nodes inside
 * `map.frame` (an answer outside the frame could not be drawn on the map). Exported for tests.
 */
export function validateManifest(data: unknown, source = 'manifest'): Manifest {
  const fail = (msg: string): never => {
    throw new Error(`${source}: ${msg}`);
  };
  if (!isRecord(data)) return fail('not an object');
  for (const key of ['world', 'name'] as const) {
    if (typeof data[key] !== 'string') fail(`missing string "${key}"`);
  }

  const pano = requireRecord(data, 'pano', fail);
  requireStrings(pano, 'pano', ['path', 'base', 'tile'], fail);
  requireNumbers(pano, 'pano', ['faceSize', 'tileSize', 'nbTiles', 'baseSize'], fail, (v) => v > 0);

  const map = requireRecord(data, 'map', fail);
  requireStrings(map, 'map', ['path'], fail);
  requireNumbers(map, 'map', ['tileSize', 'width', 'height'], fail, (v) => v > 0);
  requireNumbers(map, 'map', ['maxZoom'], fail, (v) => Number.isInteger(v) && v >= 0);
  const frame = requireRecord(map, 'frame', fail, 'map');
  requireNumbers(frame, 'map.frame', ['x0', 'z0', 'x1', 'z1'], fail);
  const { x0, z0, x1, z1 } = frame as { x0: number; z0: number; x1: number; z1: number };
  if (!(x1 > x0) || !(z0 > z1)) fail('map.frame must have x1 > x0 and z0 > z1');

  const scoring = requireRecord(data, 'scoring', fail);
  requireNumbers(scoring, 'scoring', ['maxScore', 'diagonalM'], fail, (v) => v > 0);
  requireNumbers(scoring, 'scoring', ['perfectRadiusM'], fail, (v) => v >= 0);

  const nodes = data.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return fail('"nodes" must be a non-empty array');
  nodes.forEach((n: unknown, i) => {
    if (!isRecord(n)) return fail(`nodes[${i}] is not an object`);
    if (n.id !== i) fail(`nodes[${i}].id must equal ${i}`);
    requireNumbers(n, `nodes[${i}]`, ['x', 'z'], fail);
    if (!Array.isArray(n.links)) return fail(`nodes[${i}].links must be an array`);
    n.links.forEach((l: unknown, j) => {
      if (!isRecord(l)) return fail(`nodes[${i}].links[${j}] is not an object`);
      if (!isIndex(l.to, nodes.length)) fail(`nodes[${i}].links[${j}].to = ${String(l.to)} is not a node id`);
      requireNumbers(l, `nodes[${i}].links[${j}]`, ['yaw', 'pitch', 'dist'], fail);
    });
  });

  const starts = data.starts;
  if (!Array.isArray(starts) || starts.length === 0) return fail('"starts" must be a non-empty array');
  for (const id of starts as unknown[]) {
    if (!isIndex(id, nodes.length)) return fail(`start id ${String(id)} out of range`);
    const n = nodes[id] as { x: number; z: number; wp?: unknown };
    if (n.x < x0 || n.x > x1 || n.z > z0 || n.z < z1) {
      fail(`start ${id} (${String(n.wp)}) at x=${n.x}, z=${n.z} lies outside map.frame`);
    }
  }
  return data as unknown as Manifest;
}

type Fail = (msg: string) => never;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True for a non-negative integer below `length`. */
function isIndex(v: unknown, length: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < length;
}

function requireRecord(parent: Record<string, unknown>, key: string, fail: Fail, prefix = ''): Record<string, unknown> {
  const v = parent[key];
  if (!isRecord(v)) return fail(`missing object "${prefix ? `${prefix}.` : ''}${key}"`);
  return v;
}

function requireStrings(obj: Record<string, unknown>, name: string, keys: string[], fail: Fail): void {
  for (const key of keys) {
    if (typeof obj[key] !== 'string' || obj[key] === '') fail(`${name}.${key} must be a non-empty string`);
  }
}

/** Every key must be a finite number that also satisfies `ok` (when given). */
function requireNumbers(
  obj: Record<string, unknown>,
  name: string,
  keys: string[],
  fail: Fail,
  ok: (v: number) => boolean = () => true,
): void {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) {
      fail(`${name}.${key} = ${String(v)} is not a valid number`);
    }
  }
}

/** URL of a file given relative to the data base, e.g. `dataUrl('valley/map/2/0/0.webp')`. */
export function dataUrl(relativePath: string): string {
  return `${dataBase()}/${relativePath.replace(/^\/+/, '')}`;
}
